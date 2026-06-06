/**
 * Authed API shim: /api/authed/<path> mirrors /api/<path> but requires the same
 * GitHub gate as flambeau / gcx-token (write access to pytorch/pytorch, or the
 * allow list), then forwards with the internal bypass header. Lets the `hud`
 * CLI / agents reach HUD APIs without the browser bot challenge. See
 * tools/hud-cli/README.md for the required firewall rules.
 */
import { authorizeGithubToken, bearerToken } from "lib/auth/githubAuth";
import type { NextApiRequest, NextApiResponse } from "next";

const SELF_URL = process.env.HUD_SELF_URL || "https://hud.pytorch.org";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: "Authentication required: Authorization: Bearer <token>",
    });
  }
  const auth = await authorizeGithubToken(token);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const segments = Array.isArray(req.query.path)
    ? req.query.path
    : [req.query.path];
  const subpath = segments.join("/");
  const qIndex = (req.url || "").indexOf("?");
  const qs = qIndex >= 0 ? (req.url as string).slice(qIndex) : "";
  const target = `${SELF_URL}/api/${subpath}${qs}`;

  const init: RequestInit = {
    method: req.method,
    headers: { "x-hud-internal-bot": process.env.INTERNAL_API_TOKEN || "" },
  };
  if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
    (init.headers as Record<string, string>)["content-type"] =
      "application/json";
    init.body =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }

  const upstream = await fetch(target, init);
  const text = await upstream.text();
  res.status(upstream.status);
  const ct = upstream.headers.get("content-type");
  if (ct) {
    res.setHeader("content-type", ct);
  }
  return res.send(text);
}
