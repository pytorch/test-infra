import type { NextApiRequest, NextApiResponse } from "next";
import { checkAuthWithApiToken } from "lib/auth/auth";
import {
  ApiError,
  validatePayloadSize,
  validateRelayPayload,
  extractDynamoRecord,
  checkDailyBudget,
  writeToDynamo,
} from "lib/oot/ootUtils";

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
    // 1. Auth: x-hud-internal-bot header or session
    const auth = await checkAuthWithApiToken(req, res);
    if (!auth.ok) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 2. Payload size check
    const rawBody =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    validatePayloadSize(rawBody);

    // 3. Schema validation
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const payload = validateRelayPayload(body);

    // 4. Daily budget check
    await checkDailyBudget(payload.trusted.verified_repo);

    // 5. Extract and write to DynamoDB
    const record = extractDynamoRecord(payload);
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
    return res.status(502).json({ error: "Internal error writing to DynamoDB" });
  }
}
