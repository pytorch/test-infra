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
async function _checkUserPermissions(authorization: string): Promise<boolean> {
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

// Group runners by labels with macOS support, synonyms, and name-based fallback
function getRunnerGroupLabel(runner: RunnerData): string {
  const labelNames = runner.labels.map(label => label.name);
  
  // Find labels with "." (excluding "pytorch.runners") or starting with "macos-"
  const validLabels = labelNames.filter(name => 
    (name.includes('.') && name !== 'pytorch.runners') || 
    name.startsWith('macos-')
  );
  
  if (validLabels.length > 0) {
    // Handle macOS synonyms
    const macosLabels = validLabels.filter(name => name.startsWith('macos-'));
    if (macosLabels.length > 1) {
      // Check for known synonym patterns
      const m1Labels = macosLabels.filter(name => name.includes('m1'));
      const m2Labels = macosLabels.filter(name => name.includes('m2'));
      
      if (m1Labels.length > 1) {
        return m1Labels.sort().join(' / '); // e.g., "macos-m1-14 / macos-m1-stable"
      }
      if (m2Labels.length > 1) {
        return m2Labels.sort().join(' / '); // e.g., "macos-m2-15 / macos-m2-stable"
      }
      
      // If multiple macOS labels but not synonyms, use first one
      return macosLabels[0];
    }
    
    // Use first valid label (could be dot notation or single macOS label)
    return validLabels[0];
  }
  
  // Fallback: Parse runner name for grouping info
  // Special case for ROCm runners provided by external partners that don't have proper GitHub labels
  // but use naming conventions like: linux.rocm.gpu.gfx942.1-xb8kr-runner-gnr2v
  const runnerName = runner.name;
  
  // Look for dotted prefixes before "-runner-" or "-" followed by random suffix
  const namePatterns = [
    /^([a-z]+\.[a-z0-9.]+)-[a-z0-9]+-runner-[a-z0-9]+$/i, // linux.rocm.gpu.gfx942.1-xb8kr-runner-gnr2v
    /^([a-z]+\.[a-z0-9.]+)-[a-z0-9]+$/i,                   // linux.rocm.gpu.gfx942.1-xb8kr
    /^([a-z]+\.[a-z0-9.]+\.[a-z0-9]+)/i,                  // linux.rocm.gpu prefix
  ];
  
  for (const pattern of namePatterns) {
    const match = runnerName.match(pattern);
    if (match) {
      return match[1]; // Return the prefix part
    }
  }
  
  // If name starts with a dotted pattern, extract it
  if (runnerName.includes('.')) {
    const parts = runnerName.split('-');
    if (parts[0].includes('.')) {
      return parts[0];
    }
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
    
    // Sort runners by status (idle, busy, offline) then by name
    const sortedRunners = groupRunners.sort((a, b) => {
      // Status priority: idle (0), busy (1), offline (2)
      const getStatusPriority = (runner: RunnerData) => {
        if (runner.status === "offline") return 2;
        if (runner.status === "online" && runner.busy) return 1;
        return 0; // idle
      };
      
      const aPriority = getStatusPriority(a);
      const bPriority = getStatusPriority(b);
      
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      
      // Same status, sort by name
      return a.name.localeCompare(b.name);
    });
    
    result.push({
      label,
      totalCount: groupRunners.length,
      idleCount,
      busyCount,
      offlineCount,
      runners: sortedRunners,
    });
  }
  
  // Sort groups by total count (descending), then unknown last
  result.sort((a, b) => {
    if (a.label === "unknown" && b.label !== "unknown") return 1;
    if (a.label !== "unknown" && b.label === "unknown") return -1;
    // Sort by total count descending
    return b.totalCount - a.totalCount;
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
  // if (!(await _checkUserPermissions(authorization))) {
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