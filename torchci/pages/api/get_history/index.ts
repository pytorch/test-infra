import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { hasWritePermissionsUsingOctokit } from "../../../lib/GeneralUtils";
import { getOctokitWithUserToken } from "../../../lib/github";
import { authOptions } from "../auth/[...nextauth]";

// Configure AWS S3
const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-2",
});

const TORCHAGENT_SESSION_BUCKET_NAME =
  process.env.TORCHAGENT_SESSION_BUCKET_NAME || "torchci-session-history";

interface HistorySession {
  sessionId: string;
  timestamp: string;
  date: string;
  filename: string;
  key: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  console.log("Get history API endpoint called");

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

  // Check write permissions to pytorch/pytorch repository
  const repoOwner = "pytorch";
  const repoName = "pytorch";

  let username: string;

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

  try {
    // List all objects under the user's history prefix
    const prefix = `history/${username}/`;

    console.log(`Fetching history for user ${username} with prefix: ${prefix}`);

    const listParams = {
      Bucket: TORCHAGENT_SESSION_BUCKET_NAME,
      Prefix: prefix,
    };

    const command = new ListObjectsV2Command(listParams);
    const data = await s3.send(command);

    if (!data.Contents || data.Contents.length === 0) {
      console.log(`No history found for user ${username}`);
      return res.status(200).json({ sessions: [] });
    }

    // Parse the history files and extract session information
    const sessions: HistorySession[] = data.Contents.filter(
      (obj) => obj.Key && obj.Key.endsWith(".json")
    )
      .map((obj) => {
        const key = obj.Key!;
        const filename = key.split("/").pop()!;

        // Extract timestamp and session ID from filename: HHMMSS_<session_id>.json
        const match = filename.match(
          /^(\d{4})\/(\d{2})\/(\d{2})\/(\d{6})_(.+)\.json$/
        );
        if (match) {
          const [, year, month, day, time, sessionId] = match;
          const timestamp = `${year}${month}${day}${time}`;
          const date = `${year}-${month}-${day}`;

          return {
            sessionId,
            timestamp,
            date,
            filename,
            key,
          };
        }

        // Fallback parsing for different filename formats
        const parts = filename.replace(".json", "").split("_");
        if (parts.length >= 2) {
          const timestamp = parts[0];
          const sessionId = parts.slice(1).join("_");

          return {
            sessionId,
            timestamp,
            date: timestamp.slice(0, 8),
            filename,
            key,
          };
        }

        return null;
      })
      .filter(Boolean)
      .sort((a, b) =>
        b!.timestamp.localeCompare(a!.timestamp)
      ) as HistorySession[];

    console.log(
      `Found ${sessions.length} history sessions for user ${username}`
    );

    res.status(200).json({ sessions });
  } catch (error) {
    console.error("Error fetching history:", error);
    res.status(500).json({ error: "Failed to fetch chat history" });
  }
}
