import { createAppAuth } from "@octokit/auth-app";
import { App, Octokit } from "octokit";
import type { NextApiRequest, NextApiResponse } from "next";

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
    
    // Fetch runners from GitHub API
    const response = await octokit.request("GET /orgs/{org}/actions/runners", {
      org,
      per_page: 100, // GitHub API default/max
    });

    const runners: RunnerData[] = response.data.runners.map((runner: any) => ({
      id: runner.id,
      name: runner.name,
      os: runner.os,
      status: runner.status,
      busy: runner.busy,
      labels: runner.labels.map((label: any) => ({
        id: label.id,
        name: label.name,
        type: label.type,
      })),
    }));

    return res.status(200).json({
      total_count: response.data.total_count,
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