import { getOctokit } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";
import { Octokit } from "octokit";
import {
  RunnerData,
  RunnersApiResponse,
  ALLOWED_ORGS,
  groupRunners,
} from "lib/runnerUtils";

// Simple in-memory cache with 60-second TTL
interface CacheEntry {
  data: RunnersApiResponse;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 60 * 1000; // 60 seconds


// Fetch all runners with proper pagination for a repository
async function fetchAllRepoRunners(octokit: Octokit, org: string, repo: string): Promise<RunnerData[]> {
  const allRunners: RunnerData[] = [];
  let page = 1;
  const perPage = 100; // GitHub API maximum per page

  while (true) {
    const response = await octokit.request("GET /repos/{owner}/{repo}/actions/runners", {
      owner: org,
      repo,
      per_page: perPage,
      page,
    });

    const runnersPage = response.data;
    
    // Map GitHub API response to our format with proper type safety
    const mappedRunners: RunnerData[] = runnersPage.runners.map((runner: any) => ({
      id: runner.id,
      name: runner.name,
      os: runner.os,
      status: (runner.status === "online" || runner.status === "offline") ? runner.status : "offline",
      busy: runner.busy,
      labels: runner.labels.map((label: any) => ({
        id: label.id,
        name: label.name,
        type: (label.type === "read-only" || label.type === "custom") ? label.type : "custom",
      })),
    }));

    allRunners.push(...mappedRunners);

    // Check if we've fetched all runners
    if (runnersPage.runners.length < perPage) {
      break;
    }

    page++;
  }

  return allRunners;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<RunnersApiResponse | { error: string }>
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { org, repo } = req.query;

  if (!org || typeof org !== "string") {
    return res.status(400).json({ error: "Organization parameter is required" });
  }

  if (!repo || typeof repo !== "string") {
    return res.status(400).json({ error: "Repository parameter is required" });
  }

  // Check if org is allowed
  if (!ALLOWED_ORGS.includes(org)) {
    return res.status(403).json({ 
      error: `Access denied. Only ${ALLOWED_ORGS.join(", ")} organizations are supported.` 
    });
  }

  // TODO: Remove this bypass before production - AUTH DISABLED FOR TESTING
  // Check authentication
  // const authorization = req.headers.authorization;
  // if (!authorization) {
  //   return res.status(401).json({ error: "Authorization header required" });
  // }

  // Verify user has write access to pytorch/pytorch
  // if (!(await checkUserPermissions(authorization))) {
  //   return res.status(403).json({ 
  //     error: "Access denied. Write permissions to pytorch/pytorch required." 
  //   });
  // }

  // Check cache first
  const cacheKey = `runners:${org}:${repo}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  try {
    const octokit = await getOctokit(org, repo);
    
    // Fetch all runners with proper pagination
    const runners = await fetchAllRepoRunners(octokit, org, repo);
    
    // Group runners by labels
    const groups = groupRunners(runners);
    
    const response: RunnersApiResponse = {
      groups,
      totalRunners: runners.length,
    };

    // Cache the response
    cache.set(cacheKey, {
      data: response,
      timestamp: Date.now(),
    });

    return res.status(200).json(response);
  } catch (error: any) {
    console.error("Error fetching repo runners:", error);
    
    if (error.status === 404) {
      return res.status(404).json({ 
        error: `Repository '${org}/${repo}' not found or PyTorchBot is not installed` 
      });
    }
    
    if (error.status === 403) {
      return res.status(403).json({ 
        error: `Access denied to repository '${org}/${repo}'. PyTorchBot may not have the required permissions.` 
      });
    }

    return res.status(500).json({ 
      error: `Failed to fetch runners: ${error.message}` 
    });
  }
}