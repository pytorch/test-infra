/**
 * GET /api/check-write-permissions
 *
 * Returns 200 with the caller's GitHub login if they pass the shared HUD
 * GitHub gate (write access to pytorch/pytorch, or the allow list in
 * lib/auth/allowList.json), otherwise the gate's 401/403 error. Used by
 * pages that are restricted to PyTorch maintainers, e.g. /claude_billing.
 */
import { NextApiRequest, NextApiResponse } from "next";
import {
  authorizeGithubToken,
  resolveGithubToken,
} from "../../lib/auth/githubAuth";
import { authOptions } from "./auth/[...nextauth]";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const githubToken = await resolveGithubToken(req, res, authOptions);
  if (!githubToken) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const auth = await authorizeGithubToken(githubToken);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  res.status(200).json({ authorized: true, username: auth.login });
}
