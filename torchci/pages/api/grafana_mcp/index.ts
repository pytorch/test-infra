import { spawn } from "child_process";
import { NextApiRequest, NextApiResponse } from "next";

export const config = {
  api: {
    responseLimit: false,
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
};

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  console.log("getting started with Claude");
  
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
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Transfer-Encoding', 'chunked');

  console.log(`Starting claude-p with query: ${query}`);
  
  try {
    // Spawn claude-p process
    const claudeProcess = spawn("sh", ["-c", `echo "Running claude with query: ${query}"; claude -p "${query}"`]);
    console.log(`claude-p process started with PID: ${claudeProcess.pid}`);

    // Stream stdout
    claudeProcess.stdout.on("data", (data) => {
      console.log(`Got stdout: ${data.toString().substring(0, 50)}...`);
      res.write(data);
    });

    // Stream stderr
    claudeProcess.stderr.on("data", (data) => {
      console.log(`Got stderr: ${data.toString()}`);
      res.write(`Error: ${data}`);
    });

    console.log("waiting for claude-p to finish");
    
    // Handle process completion
    claudeProcess.on("close", (code) => {
      console.log(`Process exited with code ${code}`);
      res.write(`\nProcess exited with code ${code}`);
      res.end();
    });

    // Handle request aborted
    req.on("close", () => {
      console.log("Request closed by client");
      if (!claudeProcess.killed) {
        console.log(`Killing claude process ${claudeProcess.pid}`);
        claudeProcess.kill();
      }
    });
  } catch (error) {
    console.error("Error spawning process:", error);
    res.status(500).json({ error: "Failed to spawn process" });
  }
}