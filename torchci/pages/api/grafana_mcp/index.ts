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
  console.log("Starting Claude API endpoint");

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

  console.log(`Processing query: ${query}`);

  try {
    // Setup a timeout
    const timeout = setTimeout(() => {
      console.log("Process timed out after 60 seconds");
      res.write(`{"error":"Process timed out after 60 seconds"}\n`);

      if (claudeProcess && !claudeProcess.killed) {
        console.log("Killing process due to timeout");
        claudeProcess.kill();
      }

      res.end();
    }, 120000); // 120 seconds timeout

    // Direct paths to Node and Claude
    const nodePath =
      "/Users/wouterdevriendt/.nvm/versions/node/v20.17.0/bin/node";
    const claudeJsPath =
      "/Users/wouterdevriendt/.nvm/versions/node/v20.17.0/lib/node_modules/@anthropic-ai/claude-code/cli.js";

    console.log(`Using Node: ${nodePath}`);
    console.log(`Using Claude: ${claudeJsPath}`);

    // Set environment for the process
    const env = {
      ...process.env,
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      SHELL: process.env.SHELL || "/bin/bash",
    };

    // Launch Claude directly with Node.js
    const claudeProcess = spawn(
      nodePath,
      [
        claudeJsPath,
        "-p",
        query,
        "--output-format",
        "stream-json",
        "--verbose",
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
      console.log(`Got Claude output (${output.length} bytes)`);
      res.write(output);
    });

    // Stream stderr (log errors but don't send to client)
    claudeProcess.stderr.on("data", (data) => {
      const errorMsg = data.toString();
      console.error(`Claude error: ${errorMsg.trim()}`);
    });

    console.log("Waiting for Claude to respond");

    // Handle process completion
    claudeProcess.on("close", (code) => {
      clearTimeout(timeout);
      console.log(`Claude process exited with code ${code}`);
      res.end();
    });

    // Handle process error
    claudeProcess.on("error", (error) => {
      clearTimeout(timeout);
      console.error(`Process error: ${error}`);
      res.write(`{"error":"${error.message.replace(/"/g, '\\"')}"}\n`);
      res.end();
    });

    // Handle request aborted
    req.on("close", () => {
      clearTimeout(timeout);
      console.log("Request closed by client");
      if (claudeProcess && !claudeProcess.killed) {
        console.log(`Killing Claude process ${claudeProcess.pid}`);
        claudeProcess.kill();
      }
    });
  } catch (error) {
    console.error("Error starting Claude process:", error);
    res.status(500).json({ error: String(error) });
  }
}
