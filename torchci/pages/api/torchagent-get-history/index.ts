import {
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { NextApiRequest, NextApiResponse } from "next";
import { getAuthorizedUsername } from "../../../lib/getAuthorizedUsername";
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

interface HistorySession {
  sessionId: string;
  timestamp: string;
  date: string;
  filename: string;
  key: string;
  status?: string;
  title?: string;
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

  const username = await getAuthorizedUsername(req, res, authOptions);
  if (!username) {
    return;
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

    // Get metadata for each object to fetch the title
    const objectsWithMetadata = await Promise.all(
      data.Contents.filter((obj) => obj.Key && obj.Key.endsWith(".json")).map(
        async (obj) => {
          try {
            const headResponse = await s3.send(
              new HeadObjectCommand({
                Bucket: TORCHAGENT_SESSION_BUCKET_NAME,
                Key: obj.Key!,
              })
            );

            const key = obj.Key!;
            const filename = key.split("/").pop()!;

            // Extract session info from metadata or filename
            const sessionId =
              headResponse.Metadata?.sessionid ||
              filename.replace(".json", "").split("_").slice(1).join("_");
            const timestamp =
              headResponse.Metadata?.timestamp ||
              filename.replace(".json", "").split("_")[0];
            const title = headResponse.Metadata?.title;
            const status = headResponse.Metadata?.status;

            console.log(
              `Found session: ${sessionId}, timestamp: ${timestamp}, title: ${title}`
            );

            return {
              sessionId,
              timestamp,
              date: timestamp.slice(0, 8),
              filename,
              key,
              title,
              status,
            };
          } catch (error) {
            console.error(`Failed to get metadata for ${obj.Key}:`, error);
            // Fallback to filename parsing
            const key = obj.Key!;
            const filename = key.split("/").pop()!;
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
                status: undefined,
              };
            }
            return null;
          }
        }
      )
    );

    const sessions: HistorySession[] = objectsWithMetadata
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
