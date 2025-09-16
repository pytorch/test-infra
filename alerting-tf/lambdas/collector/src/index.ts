import type { SQSHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import jwt from "jsonwebtoken";
import { AlertProcessor } from "./processor";
import { generateFingerprint } from "./fingerprint";
import { AlertStateManager } from "./database";

const tableName = process.env.STATUS_TABLE_NAME;
const githubRepo = process.env.GITHUB_REPO || ""; // format: org/repo
const githubAppSecretId = process.env.GITHUB_APP_SECRET_ID || "";

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
const processor = new AlertProcessor();
const stateManager = tableName ? new AlertStateManager(ddbClient, tableName) : null;

type GithubAppSecret = {
  github_app_client_id?: string;
  github_app_id: string;
  github_app_client_secret?: string;
  github_app_key_base64: string; // base64-encoded PEM
};

let cachedSecret: { secret: GithubAppSecret; expiresAt: number } | null = null;
let cachedInstallationToken: { token: string; expiresAt: number } | null = null;

// Simple rate limiter for GitHub API calls
class SimpleRateLimiter {
  private lastCallTime: number = 0;
  private readonly minInterval: number;

  constructor(requestsPerSecond: number = 10) {
    this.minInterval = 1000 / requestsPerSecond; // milliseconds between requests
  }

  async waitIfNeeded(): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCallTime;

    if (timeSinceLastCall < this.minInterval) {
      const waitTime = this.minInterval - timeSinceLastCall;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastCallTime = Date.now();
  }
}

const githubRateLimiter = new SimpleRateLimiter(10); // 10 requests per second

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function loadGithubSecret(): Promise<GithubAppSecret> {
  // Check if we have a valid cached secret
  const now = nowEpochSeconds();
  if (cachedSecret && cachedSecret.expiresAt > now) {
    return cachedSecret.secret;
  }

  if (!githubAppSecretId) {
    throw new Error("GITHUB_APP_SECRET_ID not set");
  }

  try {
    const res = await secrets.send(
      new GetSecretValueCommand({ SecretId: githubAppSecretId })
    );
    const secretString = res.SecretString;
    if (!secretString) throw new Error("SecretString empty for GitHub App secret");

    const parsed = JSON.parse(secretString) as GithubAppSecret;
    if (!parsed.github_app_id || !parsed.github_app_key_base64) {
      throw new Error("GitHub App secret missing required fields (github_app_id, github_app_key_base64)");
    }

    // Cache secret with 1 hour TTL for security
    cachedSecret = {
      secret: parsed,
      expiresAt: now + 3600, // 1 hour
    };

    return parsed;
  } catch (error) {
    // Clear cached secret on error to force refresh next time
    cachedSecret = null;
    throw error;
  }
}

function buildAppJwt(appId: string, pemKeyBase64: string): string {
  const pem = Buffer.from(pemKeyBase64, "base64").toString("utf8");
  const iat = nowEpochSeconds() - 30; // clock skew
  const exp = iat + 9 * 60; // 9 minutes
  return jwt.sign(
    { iat, exp, iss: appId },
    pem,
    { algorithm: "RS256" }
  );
}

async function getInstallationToken(): Promise<string> {
  // reuse cached token if valid for >60s
  if (cachedInstallationToken && cachedInstallationToken.expiresAt - nowEpochSeconds() > 60) {
    return cachedInstallationToken.token;
  }
  if (!githubRepo) throw new Error("GITHUB_REPO not set");
  const [owner, repo] = githubRepo.split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPO must be in the form org/repo");
  const secret = await loadGithubSecret();
  const appJwt = buildAppJwt(secret.github_app_id, secret.github_app_key_base64);

  const ghHeaders = {
    Authorization: `Bearer ${appJwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pytorch-alerting"
  } as const;

  // Rate limiting: Wait if needed before making API call
  await githubRateLimiter.waitIfNeeded();

  // Discover installation id for the repo
  const instResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
    method: "GET",
    headers: ghHeaders,
  });
  if (instResp.status === 404) {
    throw new Error(`GitHub App is not installed on ${githubRepo}`);
  }
  if (!instResp.ok) {
    // Security: Don't log full response body which might contain sensitive data
    const errorInfo = `${instResp.status} ${instResp.statusText}`;
    throw new Error(`Failed to get installation: ${errorInfo}`);
  }
  const instData = await instResp.json() as { id: number };

  // Rate limiting: Wait if needed before making API call
  await githubRateLimiter.waitIfNeeded();

  // Mint installation token
  const tokenResp = await fetch(`https://api.github.com/app/installations/${instData.id}/access_tokens`, {
    method: "POST",
    headers: ghHeaders,
  });
  if (!tokenResp.ok) {
    // Security: Don't log full response body which might contain sensitive data
    const errorInfo = `${tokenResp.status} ${tokenResp.statusText}`;
    throw new Error(`Failed to create installation token: ${errorInfo}`);
  }
  const tokenData = await tokenResp.json() as { token: string; expires_at: string };
  cachedInstallationToken = {
    token: tokenData.token,
    expiresAt: Math.floor(new Date(tokenData.expires_at).getTime() / 1000),
  };
  return cachedInstallationToken.token;
}

async function ensureGithubLabel(owner: string, repo: string, token: string, labelName: string, color: string = "0969da"): Promise<void> {
  // Rate limiting: Wait if needed before making API call
  await githubRateLimiter.waitIfNeeded();

  // Check if label exists
  const checkResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/labels/${encodeURIComponent(labelName)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pytorch-alerting",
    },
  });

  if (checkResp.status === 404) {
    // Rate limiting: Wait if needed before making API call
    await githubRateLimiter.waitIfNeeded();

    // Label doesn't exist, create it
    const createResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/labels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pytorch-alerting",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: labelName,
        color: color,
        description: `Alert label for ${labelName}`,
      }),
    });

    if (!createResp.ok) {
      // Security: Don't log full response body which might contain sensitive data
      const errorInfo = `${createResp.status} ${createResp.statusText}`;
      console.warn(`Failed to create label ${labelName}: ${errorInfo}`);
      // Don't throw - label creation failure shouldn't fail the whole process
    } else {
      console.log(`✅ Created GitHub label: ${labelName}`);
    }
  } else if (!checkResp.ok) {
    // Security: Don't log full response body which might contain sensitive data
    const errorInfo = `${checkResp.status} ${checkResp.statusText}`;
    console.warn(`Failed to check label ${labelName}: ${errorInfo}`);
  }
}

async function createGithubIssue(title: string, body: string, labels: string[]): Promise<number> {
  if (!githubRepo) throw new Error("GITHUB_REPO not set");
  const [owner, repo] = githubRepo.split("/");
  const token = await getInstallationToken();

  // Ensure all labels exist before creating the issue
  const labelColors: Record<string, string> = {
    "area:alerting": "0969da",
    "P0": "d73a49", // Red for P0
    "P1": "e99695", // Light red for P1
    "P2": "fbca04", // Yellow for P2
    "P3": "28a745", // Green for P3
  };

  for (const label of labels) {
    let color = labelColors[label];

    // Handle priority labels
    if (label.startsWith("Pri: ")) {
      const priority = label.split(" ")[1];
      color = labelColors[priority] || "0969da";
    }
    // Handle team labels
    else if (label.startsWith("Team: ")) {
      color = "1f883d"; // Green for teams
    }
    // Handle source labels
    else if (label.startsWith("Source: ")) {
      color = "8250df"; // Purple for sources
    }
    // Default color if not specified
    else if (!color) {
      color = "0969da";
    }

    await ensureGithubLabel(owner, repo, token, label, color);
  }

  // Rate limiting: Wait if needed before making API call
  await githubRateLimiter.waitIfNeeded();

  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pytorch-alerting",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, labels }),
  });
  if (!resp.ok) {
    // Security: Don't log full response body which might contain sensitive data
    const errorInfo = `${resp.status} ${resp.statusText}`;
    throw new Error(`Failed to create issue: ${errorInfo}`);
  }
  const data = await resp.json() as { number: number };
  return data.number;
}

export const handler: SQSHandler = async (event) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      // Log incoming record for debugging
      console.log("\n\n");
      console.log("Processing raw record")
      console.log(record);
      console.log("\n\n");
      // continue; // DISABLED: Enable main processing pipeline

      // Process the record through the normalization pipeline
      const result = await processor.processRecord(record);

      if (!result.success) {
        console.error("Alert processing failed", {
          messageId: record.messageId,
          error: result.error,
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const { fingerprint, action, metadata } = result;
      if (!fingerprint) {
        console.error("No fingerprint generated", { messageId: record.messageId });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      // Create GitHub issue for all alerts
      let emittedToGithub = false;
      let issueNumber: number | undefined;

      // TEMPORARILY DISABLED: GitHub issue creation
      if (false) {
      try {
        // Build issue title and body from normalized alert
        const alertEvent = result.metadata?.alertEvent;
        if (alertEvent) {
          const issueTitle = `[${alertEvent.priority}] ${alertEvent.title}`;
          const issueBody = [
            `**Alert Details**`,
            `- **Team**: ${alertEvent.team}`,
            `- **Priority**: ${alertEvent.priority}`,
            `- **Source**: ${alertEvent.source}`,
            `- **State**: ${alertEvent.state}`,
            `- **Occurred At**: ${alertEvent.occurred_at}`,
            alertEvent.description ? `- **Description**: ${alertEvent.description}` : "",
            alertEvent.reason ? `- **Reason**: ${alertEvent.reason}` : "",
            alertEvent.links?.runbook_url ? `- **Runbook**: ${alertEvent.links.runbook_url}` : "",
            alertEvent.links?.dashboard_url ? `- **Dashboard**: ${alertEvent.links.dashboard_url}` : "",
            "",
            `**Fingerprint**: \`${fingerprint}\``,
            "",
            "---",
            "```json",
            JSON.stringify(alertEvent.raw_provider, null, 2),
            "```"
          ].filter(Boolean).join("\n");

          // Create labels based on priority, team, source, and default area label
          const labels = [
            "area:alerting", // Default label for all alerts
            `Pri: ${alertEvent.priority}`,
            `Team: ${alertEvent.team}`,
            `Source: ${alertEvent.source}`
          ];

          issueNumber = await createGithubIssue(issueTitle, issueBody, labels);
          emittedToGithub = true;
          console.log(`✅ Created GitHub issue #${issueNumber} for fingerprint ${fingerprint}`);
        }
      } catch (err) {
        emittedToGithub = false;
        console.error("Failed to create GitHub issue", {
          fingerprint,
          error: err instanceof Error ? err.message : String(err),
        });
        // Don't fail the whole batch for GitHub issues
      }
      } // End TEMPORARILY DISABLED GitHub issue creation

      // Store to DynamoDB using new AlertStateManager
      if (stateManager && result.metadata?.alertEvent) {
        try {
          await stateManager.saveState(
            fingerprint,
            result.metadata.alertEvent,
            action,
            issueNumber
          );
          console.log(`✅ Stored alert state ${fingerprint} to DynamoDB`);
        } catch (err) {
          console.error("Failed to save alert state to DynamoDB", {
            error: err instanceof Error ? err.message : String(err),
            table: tableName,
            messageId: record.messageId,
            fingerprint,
          });
          // DynamoDB failure should fail the record
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      } else {
        console.warn("STATUS_TABLE_NAME not set or no alert event; skipping DynamoDB write");
      }

    } catch (err) {
      console.error(`Failed to process record ${record.messageId}:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  // Return batch item failures for SQS partial batch failure handling
  return {
    batchItemFailures
  };
};

export default handler;