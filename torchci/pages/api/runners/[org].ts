import { createAppAuth } from "@octokit/auth-app";
import { App, Octokit } from "octokit";
import type { NextApiRequest, NextApiResponse } from "next";
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


// Get Octokit instance authenticated for organization-level access
async function getOctokitForOrg(org: string): Promise<Octokit> {
  let privateKey = process.env.PRIVATE_KEY as string;
  privateKey = Buffer.from(privateKey, "base64").toString();

  const app = new App({
    appId: process.env.APP_ID!,
    privateKey,
  });

  // Get the installation for the organization
  const installation = await app.octokit.request(
    "GET /orgs/{org}/installation",
    { org }
  );

  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.APP_ID,
      privateKey,
      installationId: installation.data.id,
    },
  });
}


// Fetch all runners with proper pagination
async function fetchAllRunners(octokit: Octokit, org: string): Promise<RunnerData[]> {
  const allRunners: RunnerData[] = [];
  let page = 1;
  const perPage = 100; // GitHub API maximum per page

  while (true) {
    const response = await octokit.request("GET /orgs/{org}/actions/runners", {
      org,
      per_page: perPage,
      page,
    });

    const runnersPage = response.data;
    
    // Map GitHub API response to our format with proper type safety
    const mappedRunners: RunnerData[] = runnersPage.runners.map((runner: any) => {
      // Debug: Log full runner object for runners with no labels
      if (!runner.labels || runner.labels.length === 0) {
        console.log('Runner with no labels:', JSON.stringify(runner, null, 2));
      }
      
      return {
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
      };
    });

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

  const { org } = req.query;

  if (!org || typeof org !== "string") {
    return res.status(400).json({ error: "Organization parameter is required" });
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
  const cacheKey = `runners:${org}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  try {
    const octokit = await getOctokitForOrg(org);
    
    // Fetch all runners with proper pagination
    const runners = await fetchAllRunners(octokit, org);
    
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
    console.error("Error fetching runners:", error);
    
    if (error.status === 404) {
      return res.status(404).json({ 
        error: `Organization '${org}' not found or PyTorchBot is not installed for this organization` 
      });
    }
    
    if (error.status === 403) {
      return res.status(403).json({ 
        error: `Access denied to organization '${org}'. PyTorchBot may not have the required permissions.` 
      });
    }

    return res.status(500).json({ 
      error: `Failed to fetch runners: ${error.message}` 
    });
  }
}