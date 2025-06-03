import { randomUUID } from "crypto";
import { NextApiRequest, NextApiResponse } from "next";

// Configure Next.js to accept streaming responses
export const config = {
  api: {
    responseLimit: false,
    bodyParser: {
      sizeLimit: "1mb",
    },
  },
};

// Lambda function URL with direct streaming support
const LAMBDA_URL =
  process.env.GRAFANA_MCP_LAMBDA_URL ||
  "https://your-lambda-url.lambda-url.us-east-1.on.aws/";

// Auth token for Lambda access
const AUTH_TOKEN =
  process.env.GRAFANA_MCP_AUTH_TOKEN || "your-placeholder-token";

// This is critical for proper streaming - signals to browser to flush each chunk immediately
const flushStream = (res: NextApiResponse) => {
  if (typeof res.flush === "function") {
    console.log("Flushing stream");
    res.flush();
  } else {
    console.log("DOESNT EXIST");
  }
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  console.log("Claude API endpoint called - proxying to Lambda");

  // Only allow POST method
  if (req.method !== "POST") {
    console.log("Rejected: Method not allowed");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Only allow requests from localhost
  const host = req.headers.host || "";
  if (!host.includes("localhost")) {
    console.log(`Rejected: Host not allowed: ${host}`);
    return res
      .status(403)
      .json({ error: "Forbidden: Only localhost is allowed" });
  }

  // Get query from request body
  const { query } = req.body;

  if (!query || typeof query !== "string") {
    console.log("Rejected: Invalid query parameter");
    return res
      .status(400)
      .json({ error: "Query parameter is required and must be a string" });
  }

  console.log(
    `Processing query (${query.length} chars) - forwarding to Lambda`
  );

  // CRITICAL STREAMING HEADERS
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Transfer-Encoding", "chunked");

  // Flag to track if the response has been ended
  let isResponseEnded = false;

  // Helper function to safely end response
  const safeEndResponse = (message?: string) => {
    if (!isResponseEnded) {
      if (message) {
        res.write(message);
        flushStream(res);
      }
      res.end();
      isResponseEnded = true;
      console.log("Response ended");
    }
  };

  try {
    // Generate a session ID for this user (could be made more sophisticated)
    const userUuid = randomUUID();

    console.log(`Calling Lambda with userUuid: ${userUuid}`);
    console.log("and token: ", AUTH_TOKEN);

    // Write initial message to start the stream
    res.write(`{"status":"connecting","userUuid":"${userUuid}"}\n`);

    flushStream(res);

    // Call Lambda function with auth token
    const lambdaResponse = await fetch(LAMBDA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        query: query,
        userUuid: userUuid,
      }),
    });

    if (!lambdaResponse.ok) {
      throw new Error(
        `Lambda returned ${lambdaResponse.status}: ${lambdaResponse.statusText}`
      );
    }

    if (!lambdaResponse.body) {
      throw new Error("Lambda response has no body");
    }

    // Stream the response from Lambda
    const reader = lambdaResponse.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          console.log("Lambda stream ended");
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        console.log(`Streaming chunk from Lambda: ${chunk.length} bytes`);

        // Forward the chunk to the client
        res.write(chunk);
        flushStream(res);
      }
    } finally {
      reader.releaseLock();
    }

    safeEndResponse();
  } catch (error) {
    console.error(`Lambda proxy error: ${error}`);
    safeEndResponse(
      `{"error":"Lambda proxy error: ${String(error).replace(/"/g, '\\"')}"}\n`
    );
  }
}
