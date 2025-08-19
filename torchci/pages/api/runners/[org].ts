import { createAppAuth } from "@octokit/auth-app";
import { App, Octokit } from "octokit";
import type { NextApiRequest, NextApiResponse } from "next";

// GitHub API response types
interface GitHubRunnerLabel {
  id?: number;
  name: string;
  type?: "read-only" | "custom";
}

interface GitHubApiRunner {
  id: number;
  name: string;
  os: string;
  status: string; // GitHub API may return other statuses we don't know about
  busy: boolean;
  labels: GitHubRunnerLabel[];
}

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

export interface RunnersApiResponse {
  total_count: number;
  runners: RunnerData[];
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

  try {
    const octokit = await getOctokitForOrg(org);
    
    // Fetch all runners with proper pagination
    const runners = await fetchAllRunners(octokit, org);

    return res.status(200).json({
      total_count: runners.length,
      runners,
    });
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