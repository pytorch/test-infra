import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { hasWritePermissionsUsingOctokit } from "../../../lib/GeneralUtils";
import { getOctokitWithUserToken } from "../../../lib/github";
import { authOptions } from "../auth/[...nextauth]";

// Configure AWS S3
const s3 = new S3Client({
  region: process.env.AWS_REGION_TORCHAGENT || "us-east-2",
  credentials: {
    accessKeyId: process.env.OUR_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.OUR_AWS_SECRET_ACCESS_KEY!,
  },
});

const TORCHAGENT_SESSION_BUCKET_NAME =
  process.env.TORCHAGENT_SESSION_BUCKET_NAME || "torchci-session-history";

// Auth token for cookie bypass
const AUTH_TOKEN = process.env.GRAFANA_MCP_AUTH_TOKEN || "";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  console.log("Get chat history API endpoint called");

  // Only allow GET method
  if (req.method !== "GET") {
    console.log("Rejected: Method not allowed");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Check authentication
  // @ts-ignore
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user || !session?.accessToken) {
    console.log("Rejected: User not authenticated");
    return res.status(401).json({ error: "Authentication required" });
  }

  // Get sessionId from query parameters
  const { sessionId } = req.query;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "Session ID is required" });
  }

  // Check for special cookie bypass first
  const authCookie = req.cookies["GRAFANA_MCP_AUTH_TOKEN"];
  let username: string;

  if (authCookie && AUTH_TOKEN && authCookie === AUTH_TOKEN) {
    console.log("Authorized: Using GRAFANA_MCP_AUTH_TOKEN cookie bypass");
    username = "grafana-bypass-user";
  } else {
    // Standard authentication flow
    // @ts-ignore
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user || !session?.accessToken) {
      console.log("Rejected: User not authenticated");
      return res.status(401).json({ error: "Authentication required" });
    }

    // Check write permissions to pytorch/pytorch repository
    const repoOwner = "pytorch";
    const repoName = "pytorch";

    try {
      const octokit = await getOctokitWithUserToken(
        session.accessToken as string
      );
      const user = await octokit.rest.users.getAuthenticated();

      if (!user?.data?.login) {
        console.log("Rejected: Could not authenticate user with GitHub");
        return res.status(401).json({ error: "GitHub authentication failed" });
      }

      const hasWritePermissions = await hasWritePermissionsUsingOctokit(
        octokit,
        user.data.login,
        repoOwner,
        repoName
      );

      if (!hasWritePermissions) {
        console.log(
          `Rejected: User ${user.data.login} does not have write permissions to ${repoOwner}/${repoName}`
        );
        return res.status(403).json({
          error: "Write permissions to pytorch/pytorch repository required",
        });
      }

      console.log(`Authorized: User ${user.data.login} has write permissions`);
      username = user.data.login;
    } catch (error) {
      console.error("Error checking permissions:", error);
      return res.status(500).json({ error: "Permission check failed" });
    }
  }

  try {
    // Find the specific session file
    const prefix = `history/${username}/`;

    console.log(`Fetching specific session ${sessionId} for user ${username}`);

    const listParams = {
      Bucket: TORCHAGENT_SESSION_BUCKET_NAME,
      Prefix: prefix,
    };

    const listCommand = new ListObjectsV2Command(listParams);
    const data = await s3.send(listCommand);

    if (!data.Contents || data.Contents.length === 0) {
      console.log(`No history found for user ${username}`);
      return res.status(404).json({ error: "Session not found" });
    }

    // Find the specific session file by sessionId
    const sessionFile = data.Contents.find(
      (obj) =>
        obj.Key && obj.Key.includes(sessionId) && obj.Key.endsWith(".json")
    );

    if (!sessionFile || !sessionFile.Key) {
      console.log(`Session ${sessionId} not found for user ${username}`);
      return res.status(404).json({ error: "Session not found" });
    }

    // Get the actual file content
    const getParams = {
      Bucket: TORCHAGENT_SESSION_BUCKET_NAME,
      Key: sessionFile.Key,
    };

    const getCommand = new GetObjectCommand(getParams);
    const fileData = await s3.send(getCommand);

    if (!fileData.Body) {
      return res.status(404).json({ error: "Session content not found" });
    }

    const content = await fileData.Body?.transformToString();
    const sessionData = JSON.parse(content || "{}");

    console.log(`Retrieved session ${sessionId} for user ${username}`);

    res.status(200).json(sessionData);
  } catch (error) {
    console.error("Error fetching chat history:", error);
    res.status(500).json({ error: "Failed to fetch chat history" });
  }
}
