/*
  Standalone GitHub issue creation debugger.
  - No external deps required (uses Node crypto + fetch).
  - Validates your GitHub App private key (PEM) and App ID.
  - Mints an App JWT, discovers installation for the repo, creates an installation token, and opens an issue.

  Inputs (env vars):
  - GITHUB_REPO           required, format: "org/repo"
  - GITHUB_APP_ID         required, the numeric GitHub App ID
  - GITHUB_APP_KEY_BASE64 required, base64-encoded PEM private key for the GitHub App
  - (optional) GITHUB_INSTALLATION_ID if you already know it

  CLI flags (optional):
  - --title "..."   default: "GitHub Debug: test issue"
  - --body  "..."   default: "Created by local debug script"
*/

import { createSign } from "crypto";

type Args = {
  title: string;
  body: string;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let title = "GitHub Debug: test issue";
  let body = "Created by local debug script";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--title" && i + 1 < args.length) title = args[++i];
    else if (args[i] === "--body" && i + 1 < args.length) body = args[++i];
  }
  return { title, body };
}

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64Decode(input: string): string {
  try {
    return Buffer.from(input, "base64").toString("utf8");
  } catch (e) {
    throw new Error("Failed to base64-decode GITHUB_APP_KEY_BASE64: " + (e as Error).message);
  }
}

function buildAppJwt(appId: string, pemKeyBase64: string): string {
  const pem = base64Decode(pemKeyBase64);
  const firstLine = pem.split("\n")[0]?.trim();
  if (!/BEGIN (RSA )?PRIVATE KEY/.test(firstLine)) {
    throw new Error(
      `Decoded key does not look like a PEM private key. First line was: "${firstLine}".\n` +
        "Ensure you base64-encoded the raw PEM (including BEGIN/END PRIVATE KEY)."
    );
  }
  const header = { alg: "RS256", typ: "JWT" };
  const iat = Math.floor(Date.now() / 1000) - 30; // 30s skew
  const exp = iat + 9 * 60; // 9 minutes
  const payload = { iat, exp, iss: appId };
  const headerEnc = b64url(JSON.stringify(header));
  const payloadEnc = b64url(JSON.stringify(payload));
  const data = `${headerEnc}.${payloadEnc}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  const signature = signer.sign(pem);
  const sigEnc = b64url(signature);
  return `${data}.${sigEnc}`;
}

async function main() {
  const { title, body } = parseArgs();

  const repo = process.env.GITHUB_REPO || "";
  const appId = process.env.GITHUB_APP_ID || "";
  const keyB64 = process.env.GITHUB_APP_KEY_BASE64 || "";
  const installIdEnv = process.env.GITHUB_INSTALLATION_ID || "";

  if (!repo.includes("/")) throw new Error("GITHUB_REPO must be set to org/repo");
  if (!/^[0-9]+$/.test(appId)) throw new Error("GITHUB_APP_ID must be set to the numeric App ID");
  if (!keyB64) throw new Error("GITHUB_APP_KEY_BASE64 must be set to your base64-encoded PEM private key");

  const [owner, repoName] = repo.split("/");

  console.log("Repo:", repo);
  console.log("App ID:", appId);
  console.log("Key (base64) length:", keyB64.length);

  // Build App JWT
  let appJwt = "";
  try {
    appJwt = buildAppJwt(appId, keyB64);
    console.log("Built App JWT successfully. Length:", appJwt.length);
  } catch (e) {
    console.error("Failed to build App JWT:", (e as Error).message);
    process.exit(1);
  }

  const commonHeaders = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pytorch-alerting-debug",
  } as const;

  // Discover installation (unless provided)
  let installationId = installIdEnv ? Number(installIdEnv) : undefined;
  if (!installationId) {
    const instUrl = `https://api.github.com/repos/${owner}/${repoName}/installation`;
    console.log("GET", instUrl);
    const instResp = await fetch(instUrl, {
      method: "GET",
      headers: { ...commonHeaders, Authorization: `Bearer ${appJwt}` },
    });
    const instText = await instResp.text();
    console.log("Installation resp:", instResp.status, instText);
    if (!instResp.ok) throw new Error("Failed to fetch installation: " + instResp.status);
    const instData = JSON.parse(instText) as { id: number };
    installationId = instData.id;
  }
  console.log("Installation ID:", installationId);

  // Create installation token
  const tokUrl = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  console.log("POST", tokUrl);
  const tokResp = await fetch(tokUrl, {
    method: "POST",
    headers: { ...commonHeaders, Authorization: `Bearer ${appJwt}` },
  });
  const tokText = await tokResp.text();
  console.log("Token resp:", tokResp.status, tokText);
  if (!tokResp.ok) throw new Error("Failed to mint installation token: " + tokResp.status);
  const token = (JSON.parse(tokText) as { token: string }).token;

  // Create issue
  const issuesUrl = `https://api.github.com/repos/${owner}/${repoName}/issues`;
  console.log("POST", issuesUrl, { title, body });
  const issueResp = await fetch(issuesUrl, {
    method: "POST",
    headers: {
      ...commonHeaders,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body }),
  });
  const issueText = await issueResp.text();
  console.log("Issue resp:", issueResp.status, issueText);
  if (!issueResp.ok) throw new Error("Failed to create issue: " + issueResp.status);
  const issue = JSON.parse(issueText) as { number: number; html_url: string };
  console.log("Created issue #", issue.number, issue.html_url);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

