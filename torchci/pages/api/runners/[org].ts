import { createAppAuth } from "@octokit/auth-app";
import { App, Octokit } from "octokit";
import type { NextApiRequest, NextApiResponse } from "next";

// GitHub API response types (for future use)
// interface GitHubRunnerLabel {
//   id?: number;
//   name: string;
//   type?: "read-only" | "custom";
// }

// Our application response types
export interface RunnerData {
  id: number;
  name: string;
  os: string;
  status: "online" | "offline";
  busy: boolean;
  labels: Array<{
    id?: number;
    name: string;
    type: "read-only" | "custom";
  }>;
}

export interface RunnerGroup {
  label: string;
  totalCount: number;
  idleCount: number;
  busyCount: number;
  offlineCount: number;
  runners: RunnerData[];
}

export interface RunnersApiResponse {
  groups: RunnerGroup[];
  totalRunners: number;
}

// Simple in-memory cache with 60-second TTL
interface CacheEntry {
  data: RunnersApiResponse;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 60 * 1000; // 60 seconds

// Allowed organizations
const ALLOWED_ORGS = ["pytorch", "Meta-Pytorch"];

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

// Check if user has write access to pytorch/pytorch
async function checkUserPermissions(authorization: string): Promise<boolean> {
  try {
    const userOctokit = new Octokit({ auth: authorization });
    await userOctokit.rest.users.getAuthenticated();
    
    // Check if user has write access to pytorch/pytorch
    const repo = await userOctokit.rest.repos.get({
      owner: "pytorch",
      repo: "pytorch",
    });
    
    return repo.data.permissions?.push === true || repo.data.permissions?.admin === true;
  } catch (error) {
    return false;
  }
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

// Group runners by labels
function getRunnerGroupLabel(runner: RunnerData): string {
  // Find labels with "." but exclude "pytorch.runners"
  const dotLabels = runner.labels
    .map(label => label.name)
    .filter(name => name.includes('.') && name !== 'pytorch.runners');
  
  if (dotLabels.length > 0) {
    return dotLabels[0]; // Use first matching label
  }
  
  return "unknown";
}

function groupRunners(runners: RunnerData[]): RunnerGroup[] {
  const groups = new Map<string, RunnerData[]>();
  
  // Group runners by label
  for (const runner of runners) {
    const label = getRunnerGroupLabel(runner);
    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label)!.push(runner);
  }
  
  // Convert to RunnerGroup format with counts
  const result: RunnerGroup[] = [];
  for (const [label, groupRunners] of groups.entries()) {
    const idleCount = groupRunners.filter(r => r.status === "online" && !r.busy).length;
    const busyCount = groupRunners.filter(r => r.status === "online" && r.busy).length;
    const offlineCount = groupRunners.filter(r => r.status === "offline").length;
    
    result.push({
      label,
      totalCount: groupRunners.length,
      idleCount,
      busyCount,
      offlineCount,
      runners: groupRunners.sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  
  // Sort groups: known labels first, then "unknown"
  result.sort((a, b) => {
    if (a.label === "unknown" && b.label !== "unknown") return 1;
    if (a.label !== "unknown" && b.label === "unknown") return -1;
    return a.label.localeCompare(b.label);
  });
  
  return result;
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