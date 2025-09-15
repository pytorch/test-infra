import type { SQSHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import jwt from "jsonwebtoken";

const tableName = process.env.STATUS_TABLE_NAME;
const githubRepo = process.env.GITHUB_REPO || ""; // format: org/repo
const githubAppSecretId = process.env.GITHUB_APP_SECRET_ID || "";

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});

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

function extractTitleAndBody(payload: any): { title: string; body: string } {
  const title =
    (typeof payload?.title === "string" && payload.title) ||
    (typeof payload?.ruleName === "string" && payload.ruleName) ||
    (typeof payload?.AlarmName === "string" && payload.AlarmName) ||
    "Alert";
  const body =
    (typeof payload?.body === "string" && payload.body) ||
    JSON.stringify(payload, null, 2);
  return { title, body };
}

export const handler: SQSHandler = async (event) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      try {
        const parsedBody = JSON.parse(record.body);
        console.log("\n\nMy SQS message body:\n", JSON.stringify(parsedBody, null, 2));
      } catch {
        console.log("\n\nMy SQS message body (not JSON):", record.body);
      }
      if (record.messageAttributes && Object.keys(record.messageAttributes).length > 0) {
        console.log(
          "\n\nMy SQS message attributes:\n",
          JSON.stringify(record.messageAttributes, null, 2)
        );
      }

      // Decide if we should emit to GitHub based on title contents
      let emittedToGithub = false;
      let issueNumber: number | undefined;
      try {
        const parsed = (() => { try { return JSON.parse(record.body); } catch { return record.body; } })();
        const payload = typeof parsed === "string" ? { body: parsed } : parsed;
        const { title, body } = extractTitleAndBody(payload);
        // Match when either title or body contains "GitHub" (case-insensitive)
        if (/github/i.test(title) || /github/i.test(body)) {
          try {
            issueNumber = await createGithubIssue(title, body);
            emittedToGithub = true;
            console.log(`✅ Created GitHub issue #${issueNumber}`);
          } catch (err) {
            emittedToGithub = false;
            console.error("Failed to create GitHub issue", {
              error: err instanceof Error ? err.message : String(err),
            });
            // Don't fail the whole batch for GitHub issues
          }
        }
      } catch (err) {
        console.error("Error while processing GitHub emission logic", err);
      }

      // Emit raw message to DynamoDB table if configured
      if (tableName) {
        try {
          await ddbClient.send(
            new PutCommand({
              TableName: tableName,
              Item: {
                pk: record.messageId,
                body: record.body,
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
          console.log(`✅ Stored message ${record.messageId} to DynamoDB`);
        } catch (err) {
          console.error("Failed to write raw message to DynamoDB", {
            error: err instanceof Error ? err.message : String(err),
            table: tableName,
            messageId: record.messageId,
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
