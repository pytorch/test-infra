import { NextApiRequest, NextApiResponse } from "next";
import { getAuthorizedUsername } from "../../../lib/getAuthorizedUsername";
import { authOptions } from "../auth/[...nextauth]";

// Lambda function URL with direct streaming support
const LAMBDA_URL =
  process.env.GRAFANA_MCP_LAMBDA_URL ||
  "https://h3bf6e6veesbbhd7rhw6xw2slq0nnwgv.lambda-url.us-east-2.on.aws/";

// Auth token for Lambda access
const AUTH_TOKEN = process.env.GRAFANA_MCP_AUTH_TOKEN || "";

// This is critical for proper streaming - signals to browser to flush each chunk immediately
const flushStream = (res: NextApiResponse) => {
  if (typeof (res as unknown as any).flush === "function") {
    console.log("Flushing stream");
    (res as unknown as any).flush();
  } else {
    console.log("DOESNT EXIST");
  }
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  console.log("Grafana MCP API endpoint called - proxying to Lambda");

  // Only allow POST method
  if (req.method !== "POST") {
    console.log("Rejected: Method not allowed");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const username = await getAuthorizedUsername(req, res, authOptions);
  if (!username) {
    return;
  }

  // Get query and optional sessionId from request body
  const { query, sessionId } = req.body;

  if (!query || typeof query !== "string") {
    console.log("Rejected: Invalid query parameter");
    return res
      .status(400)
      .json({ error: "Query parameter is required and must be a string" });
  }

  if (sessionId && typeof sessionId !== "string") {
    console.log("Rejected: Invalid sessionId parameter");
    return res
      .status(400)
      .json({ error: "SessionId parameter must be a string if provided" });
  }

  console.log(
    `Processing query (${query.length} chars) - ${
      sessionId ? `continuing session ${sessionId}` : "new session"
    } - forwarding to Lambda`
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
    const resumeSession = !!sessionId;
    console.log(
      `Calling Lambda with sessionId: ${sessionId} (${
        resumeSession ? "resumed session" : "new session"
      })`
    );
    console.log("and token: ", AUTH_TOKEN);

    // Write initial message to start the stream
    // For continued sessions, this helps the frontend know the sessionId is being used
    res.write(
      `{"status":"connecting","sessionId":"${sessionId}","resumeSession":${resumeSession}}\n`
    );

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
        sessionId: sessionId,
        username: username,
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
