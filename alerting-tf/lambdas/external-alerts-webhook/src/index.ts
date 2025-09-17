import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { createHash, timingSafeEqual } from "crypto";

const sns = new SNSClient({});
const TOPIC_ARN = process.env.TOPIC_ARN!;
const SHARED_TOKEN = process.env.SHARED_TOKEN!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const headers = Object.fromEntries(
      Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v ?? ""]),
    );

    const token = headers["x-grafana-token"] || "";

    // Use timing-safe comparison to prevent timing attacks
    if (!isValidToken(token, SHARED_TOKEN)) {
      return { statusCode: 401, body: "unauthorized" };
    }

    const body = typeof event.body === "string" ? event.body : JSON.stringify(event.body ?? {});

    await sns.send(
      new PublishCommand({
        TopicArn: TOPIC_ARN,
        Message: body,
        MessageAttributes: {
          source: { DataType: "String", StringValue: "grafana" },
        },
      }),
    );

    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("webhook error", err);
    return { statusCode: 500, body: "error" };
  }
};

function digest(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

// Timing-safe token comparison to prevent timing attacks
function isValidToken(providedToken: string, expectedToken: string): boolean {
  if (!providedToken) return false;

  const providedDigest = digest(providedToken ?? "");
  const expectedDigest = digest(expectedToken);

  // Both are always 32 bytes, so timingSafeEqual never throws
  return timingSafeEqual(providedDigest, expectedDigest);
}

export default handler;

