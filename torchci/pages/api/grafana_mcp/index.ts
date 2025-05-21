import { spawn } from "child_process";
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

// This is critical for proper streaming - signals to browser to flush each chunk immediately
const flushStream = (res: NextApiResponse) => {
  if (typeof res.flush === "function") {
    console.log("Flushing stream");
    res.flush();
  } else {
    console.log("DOESNT EXIST");
  }
};

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log("Claude API endpoint called");

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

  console.log(`Processing query (${query.length} chars)`);

  // CRITICAL STREAMING HEADERS
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Transfer-Encoding", "chunked"); // Force chunked encoding

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

  // Create claudeProcess variable in outer scope
  let claudeProcess: ReturnType<typeof spawn> | null = null;

  try {
    // Setup a timeout
    const timeout = setTimeout(() => {
      console.log("Process timed out after 240 seconds");
      safeEndResponse(`{"error":"Process timed out after 240 seconds"}\n`);

      if (claudeProcess && !claudeProcess.killed) {
        console.log("Killing Claude process due to timeout");
        claudeProcess.kill();
      }
    }, 240000); // 240 seconds timeout

    // Environment variables
    const env = {
      ...process.env,
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      SHELL: process.env.SHELL || "/bin/bash",
      NODE_NO_BUFFERING: "1", // Ensure Node.js doesn't buffer output
    };

    // List of allowed MCP tools
    const allowedTools = [
      "mcp__grafana__create_time_series_dashboard",
      "mcp__clickhouse__readme_howto_use_clickhouse_tools",
      "mcp__clickhouse__run_clickhouse_query",
      "mcp__clickhouse__get_clickhouse_schema",
      "mcp__clickhouse__get_clickhouse_tables",
      "mcp__clickhouse__semantic_search_docs",
    ].join(",");

    console.log("Starting Claude process");

    // Write initial message to start the stream
    res.write('{"status":"starting"}\n');
    flushStream(res);

    // Launch Claude process with claude command directly
    claudeProcess = spawn(
      "claude",
      [
        "-p",
        query,
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        allowedTools,
        "--mcp-config",
        "pages/api/grafana_mcp/mcp.json",
      ],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // Explicitly disable buffering
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    console.log(`Claude process started with PID: ${claudeProcess.pid}`);

    // Register request abort handler first
    req.on("close", () => {
      clearTimeout(timeout);
      console.log("Request closed by client");
      if (claudeProcess && !claudeProcess.killed) {
        console.log(`Killing Claude process ${claudeProcess.pid}`);
        claudeProcess.kill();
      }
      safeEndResponse();
    });

    // Register error handler
    claudeProcess.on("error", (error) => {
      clearTimeout(timeout);
      console.error(`Claude process error: ${error.message}`);
      if (!isResponseEnded) {
        res.write(`{"error":"${error.message.replace(/"/g, '\\"')}"}\n`);
        flushStream(res);
      }
      safeEndResponse();
    });

    // Stream stdout (Claude's JSON output)
    claudeProcess.stdout.on("data", (data) => {
      if (isResponseEnded) return;

      const output = data.toString();
      console.log(`Got output: ${output.length} bytes`);

      // Send the chunk immediately and flush the stream
      res.write(output);
      flushStream(res);
    });

    // Handle stderr
    claudeProcess.stderr.on("data", (data) => {
      const errorMsg = data.toString();
      console.error(`Claude stderr: ${errorMsg.trim()}`);
    });

    // Handle process completion
    claudeProcess.on("close", (code) => {
      clearTimeout(timeout);
      console.log(`Claude process exited with code ${code}`);

      // Send final status message
      if (!isResponseEnded) {
        res.write(`\n{"status":"complete","code":${code || 0}}\n`);
        flushStream(res);
      }

      safeEndResponse();
    });
  } catch (error) {
    console.error(`Unexpected error: ${error}`);
    safeEndResponse(`{"error":"${String(error).replace(/"/g, '\\"')}"}\n`);
  }
}
