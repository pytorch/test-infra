import type { SQSHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import jwt from "jsonwebtoken";
import { AlertProcessor } from "./processor";
import { generateFingerprint } from "./fingerprint";

const tableName = process.env.STATUS_TABLE_NAME;
const githubRepo = process.env.GITHUB_REPO || ""; // format: org/repo
const githubAppSecretId = process.env.GITHUB_APP_SECRET_ID || "";

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
const processor = new AlertProcessor();

type GithubAppSecret = {
  github_app_client_id?: string;
  github_app_id: string;
  github_app_client_secret?: string;
  github_app_key_base64: string; // base64-encoded PEM
};

let cachedSecret: GithubAppSecret | null = null;
let cachedInstallationToken: { token: string; expiresAt: number } | null = null;

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function loadGithubSecret(): Promise<GithubAppSecret> {
  if (cachedSecret) return cachedSecret;
  if (!githubAppSecretId) {
    throw new Error("GITHUB_APP_SECRET_ID not set");
  }
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: githubAppSecretId })
  );
  const secretString = res.SecretString;
  if (!secretString) throw new Error("SecretString empty for GitHub App secret");
  const parsed = JSON.parse(secretString) as GithubAppSecret;
  if (!parsed.github_app_id || !parsed.github_app_key_base64) {
    throw new Error("GitHub App secret missing required fields (github_app_id, github_app_key_base64)");
  }
  cachedSecret = parsed;
  return parsed;
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

  // Discover installation id for the repo
  const instResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
    method: "GET",
    headers: ghHeaders,
  });
  if (instResp.status === 404) {
    throw new Error(`GitHub App is not installed on ${githubRepo}`);
  }
  if (!instResp.ok) {
    const body = await instResp.text();
    throw new Error(`Failed to get installation: ${instResp.status} ${body}`);
  }
  const instData = await instResp.json() as { id: number };

  // Mint installation token
  const tokenResp = await fetch(`https://api.github.com/app/installations/${instData.id}/access_tokens`, {
    method: "POST",
    headers: ghHeaders,
  });
  if (!tokenResp.ok) {
    const body = await tokenResp.text();
    throw new Error(`Failed to create installation token: ${tokenResp.status} ${body}`);
  }
  const tokenData = await tokenResp.json() as { token: string; expires_at: string };
  cachedInstallationToken = {
    token: tokenData.token,
    expiresAt: Math.floor(new Date(tokenData.expires_at).getTime() / 1000),
  };
  return cachedInstallationToken.token;
}

async function createGithubIssue(title: string, body: string): Promise<number> {
  if (!githubRepo) throw new Error("GITHUB_REPO not set");
  const [owner, repo] = githubRepo.split("/");
  const token = await getInstallationToken();
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pytorch-alerting",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Failed to create issue: ${resp.status} ${t}`);
  }
  const data = await resp.json() as { number: number };
  return data.number;
}

export const handler: SQSHandler = async (event) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
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

      // Create GitHub issue for all alerts (removing old /github/i filter)
      let emittedToGithub = false;
      let issueNumber: number | undefined;

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

          issueNumber = await createGithubIssue(issueTitle, issueBody);
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

      // Store to DynamoDB using new schema (placeholder - will be replaced in Phase 4)
      if (tableName) {
        try {
          await ddbClient.send(
            new PutCommand({
              TableName: tableName,
              Item: {
                pk: record.messageId, // Temporary - will change to fingerprint in Phase 4
                fingerprint,
                body: record.body,
                action,
                metadata,
                attributes: record.messageAttributes && Object.keys(record.messageAttributes).length > 0
                  ? record.messageAttributes
                  : undefined,
                eventSourceArn: record.eventSourceARN,
                receivedAt: new Date().toISOString(),
                Emitted_To_Github: emittedToGithub,
                github_issue_number: typeof issueNumber === "number" ? issueNumber : undefined,
              },
            }),
          );
          console.log(`✅ Stored normalized alert ${fingerprint} to DynamoDB`);
        } catch (err) {
          console.error("Failed to write normalized alert to DynamoDB", {
            error: err instanceof Error ? err.message : String(err),
            table: tableName,
            messageId: record.messageId,
            fingerprint,
          });
          // DynamoDB failure should fail the record
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      } else {
        console.warn("STATUS_TABLE_NAME not set; skipping DynamoDB write");
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