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
  // Only allow POST method
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Only allow requests from localhost
  const host = req.headers.host || "";
  if (!host.includes("localhost")) {
    return res
      .status(403)
      .json({ error: "Forbidden: Only localhost is allowed" });
  }

  // Get query from request body
  const { query } = req.body;

  if (!query || typeof query !== "string") {
    return res
      .status(400)
      .json({ error: "Query parameter is required and must be a string" });
  }

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
    }
  };

  try {
    // Create claudeProcess variable in outer scope
    let claudeProcess: ReturnType<typeof spawn> | null = null;

    // Setup a timeout
    const timeout = setTimeout(() => {
      safeEndResponse(`{"error":"Process timed out after 120 seconds"}\n`);
      
      if (claudeProcess && !claudeProcess.killed) {
        claudeProcess.kill();
      }
    }, 120000); // 120 seconds timeout

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
        ],
        {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      // Stream stdout (Claude's JSON output)
      claudeProcess.stdout.on("data", (data) => {
        if (!isResponseEnded) {
          res.write(data.toString());
        }
      });

      // Handle process completion
      claudeProcess.on("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });

      // Handle process error
      claudeProcess.on("error", (error) => {
        clearTimeout(timeout);
        if (!isResponseEnded) {
          res.write(`{"error":"${error.message.replace(/"/g, '\\"')}"}\n`);
        }
        reject(error);
      });

      // Handle request aborted
      req.on("close", () => {
        clearTimeout(timeout);
        if (claudeProcess && !claudeProcess.killed) {
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
        safeEndResponse(`{"error":"${error.message.replace(/"/g, '\\"')}"}\n`);
      });

  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
}