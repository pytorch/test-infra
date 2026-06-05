/**
 * GET/POST /api/gcx-token
 *
 * Self-serve endpoint that mints a read-only (Viewer) Grafana service-account
 * token for the `gcx` CLI, gated by GitHub identity the same way Flambeau is:
 * the caller must have write access to pytorch/pytorch (or be on the
 * Flambeau allow list).
 *
 * Primary usage (no browser, no extra CLI to install) — reuse an existing
 * GitHub token:
 *
 *   export GRAFANA_TOKEN=$(curl -fsSL \
 *     -H "Authorization: Bearer $(gh auth token)" \
 *     https://hud.pytorch.org/api/gcx-token)
 *
 * Browser-authenticated users (a live NextAuth session) are also accepted as a
 * fallback. Returns the raw token as text/plain by default, or JSON when the
 * caller sends `Accept: application/json` or `?format=json`.
 */
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { hasWritePermissionsUsingOctokit } from "../../lib/GeneralUtils";
import { getOctokitWithUserToken } from "../../lib/github";
import {
  grafanaServer,
  mintGcxViewerToken,
} from "../../lib/grafana/serviceAccount";
import allowList from "../../lib/torchagent/allowList.json";
import { authOptions } from "./auth/[...nextauth]";

const REPO_OWNER = "pytorch";
const REPO_NAME = "pytorch";

function getBearerToken(req: NextApiRequest): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice("bearer ".length).trim();
    return token || null;
  }
  return null;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1. Resolve a GitHub token: bearer header (curl one-liner) takes precedence,
  //    otherwise fall back to a browser NextAuth session.
  let githubToken = getBearerToken(req);
  if (!githubToken) {
    // @ts-ignore – next-auth's Session type is not exported here
    const session = await getServerSession(req, res, authOptions);
    // @ts-ignore
    githubToken = session?.accessToken ?? null;
  }
  if (!githubToken) {
    return res.status(401).json({
      error:
        "Authentication required: pass 'Authorization: Bearer <github_token>' " +
        "(e.g. $(gh auth token)) or sign in to hud.pytorch.org.",
    });
  }

  // 2. Validate GitHub identity + pytorch/pytorch write access (Flambeau gate).
  let login: string;
  try {
    const octokit = await getOctokitWithUserToken(githubToken);
    const user = await octokit.rest.users.getAuthenticated();
    login = user?.data?.login;
    if (!login) {
      return res.status(401).json({ error: "GitHub authentication failed" });
    }

    const allowed =
      (allowList as string[]).includes(login) ||
      (await hasWritePermissionsUsingOctokit(
        octokit,
        login,
        REPO_OWNER,
        REPO_NAME
      ));
    if (!allowed) {
      return res.status(403).json({
        error: `Write permissions to ${REPO_OWNER}/${REPO_NAME} required`,
      });
    }
  } catch (error) {
    console.error("gcx-token: GitHub auth/permission check failed", error);
    return res.status(401).json({ error: "GitHub authentication failed" });
  }

  // 3. Mint a read-only (Viewer) Grafana token for this user.
  try {
    const token = await mintGcxViewerToken(login);
    console.log(`gcx-token: minted Viewer token for ${login}`);

    const accept = (req.headers["accept"] as string) || "";
    if (accept.includes("application/json") || req.query.format === "json") {
      return res.status(200).json({ token, grafanaServer: grafanaServer() });
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(token);
  } catch (error) {
    console.error("gcx-token: minting failed", error);
    return res.status(500).json({ error: "Failed to mint Grafana token" });
  }
}
