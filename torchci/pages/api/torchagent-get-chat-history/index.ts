import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
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

  const username = await getAuthorizedUsername(req, res, authOptions);
  if (!username) {
    return;
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

    // Check if this session has been shared by looking for a tracking file
    const sharedTrackingKey = `shared-tracking/${username}/${sessionId}.json`;
    let sharedInfo = null;

    try {
      const sharedTrackingParams = {
        Bucket: TORCHAGENT_SESSION_BUCKET_NAME,
        Key: sharedTrackingKey,
      };

      const sharedTrackingCommand = new GetObjectCommand(sharedTrackingParams);
      const sharedTrackingData = await s3.send(sharedTrackingCommand);

      if (sharedTrackingData.Body) {
        const sharedContent = await sharedTrackingData.Body.transformToString();
        const trackingData = JSON.parse(sharedContent || "{}");
        sharedInfo = {
          uuid: trackingData.shareUuid,
          sharedAt: trackingData.sharedAt,
          shareUrl: trackingData.shareUrl,
        };
      }
    } catch (error) {
      // No shared tracking file exists, which is fine
      console.log(`No shared tracking found for session ${sessionId}`);
    }

    // Add shared info to session data if it exists
    const responseData = {
      ...sessionData,
      ...(sharedInfo && { shared: sharedInfo }),
    };

    console.log(
      `Retrieved session ${sessionId} for user ${username}, shared: ${
        sharedInfo ? "yes" : "no"
      }`
    );

    res.status(200).json(responseData);
  } catch (error) {
    console.error("Error fetching chat history:", error);
    res.status(500).json({ error: "Failed to fetch chat history" });
  }
}
