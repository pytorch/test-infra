import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NextApiRequest, NextApiResponse } from "next";
import { v4 as uuidv4 } from "uuid";
import { getAuthorizedUsername } from "../../lib/getAuthorizedUsername";
import { authOptions } from "./auth/[...nextauth]";

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
  console.log("Share chat API endpoint called");

  // Only allow POST method
  if (req.method !== "POST") {
    console.log("Rejected: Method not allowed");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Check authentication
  const username = await getAuthorizedUsername(req, res, authOptions);
  if (!username) {
    return;
  }

  // Get sessionId from request body
  const { sessionId } = req.body;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "Session ID is required" });
  }

  try {
    // Find the specific session file
    const prefix = `history/${username}/`;
    console.log(`Finding session ${sessionId} for user ${username}`);

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

    // Generate a unique UUID for the shared session
    const shareUuid = uuidv4();

    // Copy the session to the shared location
    const sharedKey = `shared/${shareUuid}.json`;

    const putParams = {
      Bucket: TORCHAGENT_SESSION_BUCKET_NAME,
      Key: sharedKey,
      Body: content,
      ContentType: "application/json",
      Metadata: {
        originalSessionId: sessionId,
        originalUsername: username,
        sharedAt: new Date().toISOString(),
      },
    };

    const putCommand = new PutObjectCommand(putParams);
    await s3.send(putCommand);

    // Create a separate tracking file to avoid race conditions with the original session
    const sharedTrackingKey = `shared-tracking/${username}/${sessionId}.json`;
    const sharedTrackingData = {
      originalSessionId: sessionId,
      originalUsername: username,
      shareUuid: shareUuid,
      sharedAt: new Date().toISOString(),
      shareUrl: `https://${req.headers.host}/flambeau/s/${shareUuid}`,
      originalFileKey: sessionFile.Key,
    };

    const trackingParams = {
      Bucket: TORCHAGENT_SESSION_BUCKET_NAME,
      Key: sharedTrackingKey,
      Body: JSON.stringify(sharedTrackingData, null, 2),
      ContentType: "application/json",
    };

    const trackingCommand = new PutObjectCommand(trackingParams);
    await s3.send(trackingCommand);

    // Generate the public URL, based on current url
    const shareUrl = `https://${req.headers.host}/flambeau/s/${shareUuid}`;

    console.log(
      `Shared session ${sessionId} as ${shareUuid} for user ${username}`
    );

    res.status(200).json({
      success: true,
      shareUrl,
      shareId: shareUuid,
    });
  } catch (error) {
    console.error("Error sharing chat:", error);
    res.status(500).json({ error: "Failed to share chat" });
  }
}
