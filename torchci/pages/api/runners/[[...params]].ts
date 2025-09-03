/**
 * @fileoverview Unified API endpoint for GitHub Actions runners data
 *
 * This route handles both organization-level and repository-level
 * GitHub Actions runner queries using catch-all routing.
 *
 * Supported routes:
 * - GET /api/runners/[org] - Fetch all runners for an organization
 * - GET /api/runners/[org]/[repo] - Fetch runners specific to a repository
 *
 */

import { createAppAuth } from "@octokit/auth-app";
import { groupRunners, RunnerData, RunnersApiResponse } from "lib/runnerUtils";
import type { NextApiRequest, NextApiResponse } from "next";
import { App, Octokit } from "octokit";

// Constants
export const ALLOWED_ORGS = ["pytorch", "meta-pytorch"];

// Shared function to map GitHub API runner response to our format
function mapRunnerFromGitHubAPI(runner: any): RunnerData {
  // Debug: Log full runner object for runners with no labels
  if (!runner.labels || runner.labels.length === 0) {
    console.log("Runner with no labels:", JSON.stringify(runner, null, 2));
  }

  return {
    id: runner.id,
    name: runner.name,
    os: runner.os,
    status:
      runner.status === "online" || runner.status === "offline"
        ? runner.status
        : "offline",
    busy: runner.busy,
    labels: runner.labels.map((label: any) => ({
      id: label.id,
      name: label.name,
      type:
        label.type === "read-only" || label.type === "custom"
          ? label.type
          : "custom",
    })),
  };
}

// Shared pagination logic for fetching runners
async function paginateRunners(
  octokit: Octokit,
  requestPath: string,
  requestParams: Record<string, any>
): Promise<RunnerData[]> {
  const allRunners: RunnerData[] = [];
  let page = 1;
  const perPage = 100; // GitHub API maximum per page

  while (true) {
    const response = await octokit.request(requestPath, {
      ...requestParams,
      per_page: perPage,
      page,
    });

    const runnersPage = response.data;
    const mappedRunners: RunnerData[] = runnersPage.runners.map(
      mapRunnerFromGitHubAPI
    );
    allRunners.push(...mappedRunners);

    // Check if we've fetched all runners
    if (runnersPage.runners.length < perPage) {
      break;
    }

    page++;
  }

  return allRunners;
}

// Shared error handling function
function handleAPIError(
  error: any,
  res: NextApiResponse<RunnersApiResponse | { error: string }>,
  org: string,
  repo?: string
) {
  console.error("Error fetching runners:", error);

  // Handle GitHub API-specific errors
  if (error.response) {
    const status = error.response.status;
    const message = error.response.data?.message || error.message;

    if (status === 404) {
      const target = repo
        ? `Repository '${org}/${repo}'`
        : `Organization '${org}'`;
      return res.status(404).json({
        error: `${target} not found or PyTorchBot is not installed`,
      });
    }

    if (status === 403) {
      return res.status(403).json({
        error: "Access forbidden. Check authentication and permissions.",
      });
    }

    return res.status(status).json({ error: message });
  }

  // Handle network errors
  if (error.code === "ECONNREFUSED" || error.code === "ETIMEDOUT") {
    return res.status(503).json({
      error: "GitHub API is temporarily unavailable",
    });
  }

  // Generic error
  return res.status(500).json({
    error: "Internal server error",
  });
}

// Shared authentication logic
async function getAuthenticatedOctokit(
  org: string,
  repo?: string
): Promise<Octokit> {
  // Both org and repo runner access require organization-level authentication
  return await getOctokitForOrg(org);
}

// Cache interface
interface CacheEntry {
  data: RunnersApiResponse;
  timestamp: number;
}

// Simple in-memory cache with 120-second TTL
const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 120 * 1000; // 120 seconds

// Get Octokit instance authenticated for organization-level access
async function getOctokitForOrg(org: string): Promise<Octokit> {
  let privateKey = process.env.PRIVATE_KEY as string;
  privateKey = Buffer.from(privateKey, "base64").toString();

  const app = new App({
    appId: process.env.APP_ID as string,
    privateKey,
  });

  const installation = await app.octokit.request(
    "GET /orgs/{org}/installation",
    {
      org,
    }
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

// Fetch all runners with proper pagination for organization
async function fetchAllOrgRunners(
  octokit: Octokit,
  org: string
): Promise<RunnerData[]> {
  return paginateRunners(octokit, "GET /orgs/{org}/actions/runners", { org });
}

// Fetch all runners with proper pagination for a repository
async function fetchAllRepoRunners(
  octokit: Octokit,
  org: string,
  repo: string
): Promise<RunnerData[]> {
  return paginateRunners(octokit, "GET /repos/{owner}/{repo}/actions/runners", {
    owner: org,
    repo,
  });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<RunnersApiResponse | { error: string }>
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { params } = req.query;

  // Parse the route parameters
  const routeParams = Array.isArray(params) ? params : [];
  const org = routeParams[0];
  const repo = routeParams[1];

  if (!org || typeof org !== "string") {
    return res
      .status(400)
      .json({ error: "Organization parameter is required" });
  }

  if (repo && typeof repo !== "string") {
    return res
      .status(400)
      .json({ error: "Repository parameter must be a string" });
  }

  // Check if org is allowed
  if (!ALLOWED_ORGS.includes(org.toLowerCase())) {
    return res.status(403).json({
      error: `Access denied. Only ${ALLOWED_ORGS.join(
        ", "
      )} organizations are supported.`,
    });
  }

  // Generate cache key based on route type
  const cacheKey = repo ? `${org}/${repo}` : org;

  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  try {
    // Get authenticated Octokit instance
    const octokit = await getAuthenticatedOctokit(org, repo);

    // Fetch runners based on route type
    const runners = repo
      ? await fetchAllRepoRunners(octokit, org, repo)
      : await fetchAllOrgRunners(octokit, org);

    // Group runners by labels
    const groups = groupRunners(runners);

    const result: RunnersApiResponse = {
      groups,
      totalRunners: runners.length,
    };

    // Cache the result
    cache.set(cacheKey, {
      data: result,
      timestamp: Date.now(),
    });

    return res.status(200).json(result);
  } catch (error: any) {
    return handleAPIError(error, res, org, repo);
  }
}
