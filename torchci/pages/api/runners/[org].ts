/**
 * @fileoverview API endpoint for GitHub Actions runners data
 *
 * This route handles organization-level GitHub Actions runner queries.
 *
 * Supported routes:
 * - GET /api/runners/[org] - Fetch all runners for an organization
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
  org: string
) {
  console.error("Error fetching runners:", error);

  // Handle GitHub API-specific errors
  if (error.response) {
    const status = error.response.status;
    const message = error.response.data?.message || error.message;

    if (status === 404) {
      return res.status(404).json({
        error: `Organization '${org}' not found or PyTorchBot is not installed`,
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

// Authentication logic - only org-level supported
async function getAuthenticatedOctokit(org: string): Promise<Octokit> {
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


export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<RunnersApiResponse | { error: string }>
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { org } = req.query;

  if (!org || typeof org !== "string") {
    return res
      .status(400)
      .json({ error: "Organization parameter is required" });
  }

  // Check if org is allowed
  if (!ALLOWED_ORGS.includes(org.toLowerCase())) {
    return res.status(403).json({
      error: `Access denied. Only ${ALLOWED_ORGS.join(
        ", "
      )} organizations are supported.`,
    });
  }

  // Generate cache key for organization
  const cacheKey = org;

  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  try {
    // Get authenticated Octokit instance
    const octokit = await getAuthenticatedOctokit(org);

    // Fetch organization runners
    const runners = await fetchAllOrgRunners(octokit, org);

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
    return handleAPIError(error, res, org);
  }
}
