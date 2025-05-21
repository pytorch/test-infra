import { spawn } from "child_process";
import { NextApiRequest, NextApiResponse } from "next";

export const config = {
  api: {
    responseLimit: false,
    bodyParser: {
      sizeLimit: "1mb",
    },
  },
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

  // Set headers for streaming
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Flag to track if the response has been ended
  let isResponseEnded = false;

  // Helper function to safely end response
  const safeEndResponse = (message?: string) => {
    if (!isResponseEnded) {
      if (message) {
        res.write(message);
      }
      res.end();
      isResponseEnded = true;
      console.log("Response ended");
    }
  };

  try {
    // Create claudeProcess variable in outer scope
    let claudeProcess: ReturnType<typeof spawn> | null = null;

    // Setup a timeout
    const timeout = setTimeout(() => {
      console.log("Process timed out after 240 seconds");
      safeEndResponse(`{"error":"Process timed out after 240 seconds"}\n`);

      if (claudeProcess && !claudeProcess.killed) {
        console.log("Killing Claude process due to timeout");
        claudeProcess.kill();
      }
    }, 240000); // 240 seconds timeout

    // Create a promise to capture when the process ends
    const processPromise = new Promise((resolve, reject) => {
      // Environment variables
      const env = {
        ...process.env,
        PATH: process.env.PATH || "",
        HOME: process.env.HOME || "",
        SHELL: process.env.SHELL || "/bin/bash",
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
        }
      );

      console.log(`Claude process started with PID: ${claudeProcess.pid}`);

      // Stream stdout (Claude's JSON output)
      claudeProcess.stdout.on("data", (data) => {
        const output = data.toString();
        console.log(`Got output: ${output.length} bytes`);
        if (!isResponseEnded) {
          res.write(output);
        }
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
        resolve(code);
      });

      // Handle process error
      claudeProcess.on("error", (error) => {
        clearTimeout(timeout);
        console.error(`Claude process error: ${error.message}`);
        if (!isResponseEnded) {
          res.write(`{"error":"${error.message.replace(/"/g, '\\"')}"}\n`);
        }
        reject(error);
      });

      // Handle request aborted
      req.on("close", () => {
        clearTimeout(timeout);
        console.log("Request closed by client");
        if (claudeProcess && !claudeProcess.killed) {
          console.log(`Killing Claude process ${claudeProcess.pid}`);
          claudeProcess.kill();
        }
        safeEndResponse();
        resolve(null);
      });
    });

    // Wait for the process to complete and end the response
    processPromise
      .then(() => {
        safeEndResponse();
      })
      .catch((error) => {
        console.error(`Promise error: ${error.message}`);
        safeEndResponse(`{"error":"${error.message.replace(/"/g, '\\"')}"}\n`);
      });
  } catch (error) {
    console.error(`Unexpected error: ${error}`);
    res.status(500).json({ error: String(error) });
  }
}