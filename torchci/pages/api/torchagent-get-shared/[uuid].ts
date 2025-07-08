import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NextApiRequest, NextApiResponse } from "next";

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
  console.log("Get shared chat API endpoint called");

  // Only allow GET method
  if (req.method !== "GET") {
    console.log("Rejected: Method not allowed");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Get UUID from query parameters
  const { uuid } = req.query;
  if (!uuid || typeof uuid !== "string") {
    return res.status(400).json({ error: "UUID is required" });
  }

  try {
    // Get the shared file from S3
    const sharedKey = `shared/${uuid}.json`;

    console.log(`Fetching shared session: ${sharedKey}`);

    const getParams = {
      Bucket: TORCHAGENT_SESSION_BUCKET_NAME,
      Key: sharedKey,
    };

    const getCommand = new GetObjectCommand(getParams);
    const fileData = await s3.send(getCommand);

    if (!fileData.Body) {
      return res.status(404).json({ error: "Shared session not found" });
    }

    const content = await fileData.Body?.transformToString();
    const sessionData = JSON.parse(content || "{}");

    console.log(`Retrieved shared session ${uuid}`);

    // Return the session data
    res.status(200).json(sessionData);
  } catch (error) {
    console.error("Error fetching shared chat:", error);
    if (error instanceof Error && error.name === "NoSuchKey") {
      res.status(404).json({ error: "Shared session not found" });
    } else {
      res.status(500).json({ error: "Failed to fetch shared chat" });
    }
  }
}
