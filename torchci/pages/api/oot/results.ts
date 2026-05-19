import {
  ApiError,
  extractDynamoRecord,
  validatePayloadSize,
  writeToDynamo,
} from "lib/oot/ootUtils";
import type { NextApiRequest, NextApiResponse } from "next";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "2mb",
    },
  },
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 1. Auth: dedicated X-OOT-Relay-Token header
    const relayToken = req.headers["x-oot-relay-token"];
    if (!relayToken || relayToken !== process.env.OOT_RELAY_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 2. Payload size cap (safety net — relay should also enforce this)
    const rawBody =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    validatePayloadSize(rawBody);

    // 3. Extract and write to DynamoDB via UpdateItem
    // Schema validation is done by the relay before forwarding.
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const record = extractDynamoRecord(body);
    await writeToDynamo(record);

    return res.status(200).json({
      ok: true,
      status: record.status,
      dynamoKey: record.dynamoKey,
    });
  } catch (err: any) {
    if (err instanceof ApiError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("OOT results handler error:", err);
    return res
      .status(500)
      .json({ error: "Internal error writing to DynamoDB" });
  }
}
