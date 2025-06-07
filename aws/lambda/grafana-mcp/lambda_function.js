const { spawn } = require("child_process");
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");

// Initialize AWS clients
const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
});

// S3 configuration
const S3_BUCKET = process.env.SESSION_BUCKET_NAME || "grafana-mcp-sessions";
const SESSION_PREFIX = "sessions/";

/**
 * Download and extract session from S3
 */
async function downloadSessionFromS3(userUuid, tempDir) {
  const s3Key = `${SESSION_PREFIX}${userUuid}/session.zip`;

  try {
    console.log(`Downloading session for user ${userUuid} from S3`);

    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
    });

    const response = await s3Client.send(command);

    if (response.Body) {
      // Convert stream to buffer
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const zipBuffer = Buffer.concat(chunks);

      // Extract zip to temp directory
      const zip = new AdmZip(zipBuffer);
      zip.extractAllTo(tempDir, true);

      console.log(`Successfully restored session for user ${userUuid}`);
      return true;
    }
  } catch (error) {
    if (error.name === "NoSuchKey") {
      console.log(
        `No existing session found for user ${userUuid}, starting fresh`
      );
      return false;
    }
    console.error(`Error downloading session for user ${userUuid}:`, error);
    return false;
  }
}

/**
 * Upload session to S3 as zip
 */
async function uploadSessionToS3(userUuid, tempDir) {
  const s3Key = `${SESSION_PREFIX}${userUuid}/session.zip`;

  try {
    console.log(`Uploading session for user ${userUuid} to S3`);

    // Create zip from entire temp directory
    const zip = new AdmZip();

    const addDirectory = (dirPath, zipPath = "") => {
      if (!fs.existsSync(dirPath)) return;

      const files = fs.readdirSync(dirPath);

      for (const file of files) {
        const fullPath = path.join(dirPath, file);
        const zipFilePath = zipPath ? path.join(zipPath, file) : file;

        if (fs.statSync(fullPath).isDirectory()) {
          addDirectory(fullPath, zipFilePath);
        } else {
          zip.addLocalFile(fullPath, zipPath);
        }
      }
    };

    addDirectory(tempDir);
    const zipBuffer = zip.toBuffer();

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: zipBuffer,
      ContentType: "application/zip",
      Metadata: {
        userUuid: userUuid,
        uploadTimestamp: new Date().toISOString(),
      },
    });

    await s3Client.send(command);
    console.log(`Successfully uploaded session for user ${userUuid}`);
  } catch (error) {
    console.error(`Error uploading session for user ${userUuid}:`, error);
  }
}

/**
 * Lambda handler with streaming response - matches torchci implementation
 */
// Environment variables for authentication
const AUTH_TOKEN = process.env.AUTH_TOKEN || "default-secure-token";

exports.handler = awslambda.streamifyResponse(
  async (event, responseStream, context) => {
    console.log("Claude API endpoint called");

    // Set CORS headers for streaming response
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Transfer-Encoding": "chunked",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // Handle OPTIONS request for CORS
    if (
      event.requestContext &&
      event.requestContext.http &&
      event.requestContext.http.method === "OPTIONS"
    ) {
      responseStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers,
      });
      responseStream.end();
      return;
    }

    // Write headers
    responseStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers,
    });

    // Validate authorization token
    const authHeader =
      event.headers &&
      (event.headers.Authorization || event.headers.authorization);
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log("Rejected: Missing or invalid authorization header");
      responseStream.write(
        '{"error":"Missing or invalid authorization header"}\n'
      );
      responseStream.end();
      return;
    }

    const token = authHeader.split("Bearer ")[1];
    if (token !== AUTH_TOKEN) {
      console.log("Rejected: Invalid token");
      responseStream.write('{"error":"Invalid authorization token"}\n');
      responseStream.end();
      return;
    }

    // Parse the request body
    let body;
    try {
      body =
        typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch (error) {
      console.error("Error parsing request body:", error);
      responseStream.write('{"error":"Invalid request body"}\n');
      responseStream.end();
      return;
    }

    const { query, userUuid } = body;

    if (!query || typeof query !== "string") {
      console.log("Rejected: Invalid query parameter");
      responseStream.write(
        '{"error":"Query parameter is required and must be a string"}\n'
      );
      responseStream.end();
      return;
    }

    if (!userUuid) {
      console.log("Rejected: userUuid parameter required");
      responseStream.write(
        '{"error":"userUuid parameter is required for session management"}\n'
      );
      responseStream.end();
      return;
    }

    console.log(
      `Processing query (${query.length} chars) for user ${userUuid}`
    );

    // Flag to track if the response has been ended
    let isResponseEnded = false;

    // Create claudeProcess variable in outer scope
    let claudeProcess = null;

    // Helper function to safely end response
    const safeEndResponse = (message) => {
      if (!isResponseEnded) {
        if (message) {
          responseStream.write(message);
        }
        responseStream.end();
        isResponseEnded = true;
        console.log("Response ended");
      }
    };

    try {
      // Setup a timeout (14.5 minutes to stay under Lambda's 15 min limit)
      const timeout = setTimeout(() => {
        console.log("Process timed out after 870 seconds");
        safeEndResponse('{"error":"Process timed out after 870 seconds"}\n');

        if (claudeProcess && !claudeProcess.killed) {
          console.log("Killing Claude process due to timeout");
          claudeProcess.kill();
        }
      }, 870000);

      // Create unique temp directory with timestamp and random string
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 10);
      const sessionId = `${timestamp}_${randomStr}`;
      const tempDir = path.join("/tmp", `claude_hud_${sessionId}`);

      // Create temp directory
      try {
        fs.mkdirSync(tempDir, { recursive: true });
        console.log(`Created temp directory: ${tempDir}`);

        // Download existing session if it exists
        await downloadSessionFromS3(userUuid, tempDir);

        // Copy CLAUDE.md to temp directory
        const claudeMdPath = path.join(__dirname, "CLAUDE.md");
        if (fs.existsSync(claudeMdPath)) {
          fs.copyFileSync(claudeMdPath, path.join(tempDir, "CLAUDE.md"));
          console.log("Copied CLAUDE.md to temp directory");
        }

        // No longer need to create .env file, as the MCP servers in Fargate
        // have their own environment variables provided directly

        // Create mcp.json with remote SSE servers
        const grafanaUrl =
          process.env.GRAFANA_MCP_URL ||
          "http://grafana-mcp.grafana-mcp-lambda.local:8000";
        const clickhouseUrl =
          process.env.CLICKHOUSE_MCP_URL ||
          "http://clickhouse-mcp.grafana-mcp-lambda.local:8001";

        const mcpConfig = {
          mcpServers: {
            grafana: {
              url: `${grafanaUrl}/sse`,
              type: "sse",
            },
            clickhouse: {
              url: `${clickhouseUrl}/sse`,
              type: "sse",
            },
          },
        };

        fs.writeFileSync(
          path.join(tempDir, "mcp.json"),
          JSON.stringify(mcpConfig, null, 2)
        );
        console.log("Created mcp.json with remote SSE servers");
      } catch (err) {
        console.error(`Error creating temp directory: ${err}`);
        return safeEndResponse(
          '{"error":"Failed to create temp environment"}\n'
        );
      }

      // Environment variables
      const env = {
        ...process.env,
        PATH: "/opt/bin:/opt/nodejs/node_modules/.bin:/opt/python/bin:/usr/local/bin:/usr/bin:/bin",
        PYTHONPATH: "/opt/python:/opt/python/lib/python3.11/site-packages",
        HOME: tempDir,
        SHELL: "/bin/bash",
        NODE_NO_BUFFERING: "1", // Ensure Node.js doesn't buffer output
        CLAUDE_CODE_USE_BEDROCK: "1", // Use Bedrock for Claude code execution
        ANTHROPIC_MODEL: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      };

      // Set working directory to temp directory
      const cwd = tempDir;

      // List of allowed MCP tools (matching torchci but with updated tool names)
      const allowedTools = [
        "mcp__grafana-mcp__get_dashboard",
        "mcp__grafana-mcp__create_dashboard",
        "mcp__grafana-mcp__update_dashboard",
        "mcp__grafana-mcp__list_datasources",
        "mcp__grafana-mcp__create_datasource",
        "mcp__clickhouse-pip__readme_howto_use_clickhouse_tools",
        "mcp__clickhouse-pip__run_clickhouse_query",
        "mcp__clickhouse-pip__get_clickhouse_schema",
        "mcp__clickhouse-pip__get_clickhouse_tables",
        "mcp__clickhouse-pip__semantic_search_docs",
        "mcp__clickhouse-pip__lint_clickhouse_query",
      ].join(",");

      console.log("Starting Claude process");

      // Write initial message to start the stream
      responseStream.write(
        `{"status":"starting","tempDir":"${tempDir}","userUuid":"${userUuid}"}\n`
      );

      // Launch Claude process with bundled claude command
      claudeProcess = spawn(
        path.join(__dirname, "bin/claude"),
        [
          "-p",
          "Use TodoRead/TodoWrite to create a plan first (find tables, understand tables, create query, optimize query for Grafana, make Grafana dashboard). " +
            query,
          "--output-format",
          "stream-json",
          "--verbose",
          "--allowedTools",
          allowedTools,
          "--mcp-config",
          path.join(tempDir, "mcp.json"),
        ],
        {
          env,
          cwd, // Run from the temp directory
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      console.log(`Claude process started with PID: ${claudeProcess.pid}`);

      // Register error handler
      claudeProcess.on("error", (error) => {
        clearTimeout(timeout);
        console.error(`Claude process error: ${error.message}`);
        if (!isResponseEnded) {
          responseStream.write(
            `{"error":"${error.message.replace(/"/g, '\\"')}"}\n`
          );
        }
        safeEndResponse();
      });

      // Stream stdout (Claude's JSON output)
      claudeProcess.stdout.on("data", (data) => {
        if (isResponseEnded) return;

        const output = data.toString();
        console.log(`Got output: ${output.length} bytes`);

        // Check if this output contains usage data for debugging
        if (output.includes('"usage"') || output.includes('"total_tokens"')) {
          console.log("Found token data in chunk:", output);
        }

        // Send the chunk immediately
        responseStream.write(output);
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

        // Upload session to S3 before ending
        uploadSessionToS3(userUuid, tempDir)
          .then(() => {
            console.log("Session uploaded to S3");

            // Send final status message with token usage if available
            if (!isResponseEnded) {
              // Check if we can find any token usage information in the process output
              const usageFilePath = path.join(tempDir, "usage.json");
              let tokenUsage = {};

              try {
                if (fs.existsSync(usageFilePath)) {
                  const usageData = fs.readFileSync(usageFilePath, "utf8");
                  tokenUsage = JSON.parse(usageData);
                  console.log("Found token usage data:", tokenUsage);
                }
              } catch (error) {
                console.error("Error reading token usage data:", error);
              }

              responseStream.write(
                `\n{"status":"complete","code":${
                  code || 0
                },"tempDir":"${tempDir}","usage":${JSON.stringify(
                  tokenUsage
                )}}\n`
              );
            }

            safeEndResponse();
          })
          .catch((uploadError) => {
            console.error("Error uploading session:", uploadError);
            if (!isResponseEnded) {
              responseStream.write(
                `\n{"status":"complete","code":${code || 0},"uploadError":"${
                  uploadError.message
                }"}\n`
              );
            }
            safeEndResponse();
          });
      });
    } catch (error) {
      console.error(`Unexpected error: ${error}`);
      safeEndResponse(`{"error":"${String(error).replace(/"/g, '\\"')}"}\n`);
    }
  }
);
