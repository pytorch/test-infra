/**
 * GET/POST /api/gcx-token
 *
 * Self-serve endpoint that mints a read-only (Viewer) Grafana service-account
 * token for the `gcx` CLI, gated by GitHub identity the same way Flambeau is:
 * the caller must have write access to pytorch/pytorch (or be on the
 * Flambeau allow list).
 *
 * Primary usage (no browser, no extra CLI to install) reuses an existing
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
import {
  authorizeGithubToken,
  resolveGithubToken,
} from "../../lib/auth/githubAuth";
import {
  grafanaServer,
  mintGcxViewerToken,
} from "../../lib/grafana/serviceAccount";
import { authOptions } from "./auth/[...nextauth]";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1. Resolve a GitHub token (bearer header, else NextAuth session).
  const githubToken = await resolveGithubToken(req, res, authOptions);
  if (!githubToken) {
    return res.status(401).json({
      error:
        "Authentication required: pass 'Authorization: Bearer <github_token>' " +
        "(e.g. $(gh auth token)) or sign in to hud.pytorch.org.",
    });
  }

  // 2. Validate GitHub identity + pytorch/pytorch write access (Flambeau gate).
  const auth = await authorizeGithubToken(githubToken);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  // 3. Mint a read-only (Viewer) Grafana token for this user.
  try {
    const token = await mintGcxViewerToken(auth.login);
    console.log(`gcx-token: minted Viewer token for ${auth.login}`);

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
