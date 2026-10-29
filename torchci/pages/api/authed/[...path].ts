/**
 * Authed API shim: /api/authed/<path> mirrors /api/<path> but requires the same
 * GitHub gate as gcx-token (write access to pytorch/pytorch, or the allow
 * list), then forwards to the real endpoint. Lets the `hud` CLI / agents
 * reach HUD APIs without the browser bot challenge.
 *
 * One Vercel firewall bypass rule is needed: Request Path starts with
 * /api/authed/ (safe: the shim validates the token, bad token -> 401). The
 * forward below is a function calling its own deployment, which Vercel does not
 * put through the bot challenge. If that ever changes (forward starts 429ing),
 * re-add an `x-hud-internal-bot` header here plus a firewall bypass for it.
 */
import { CODE_BY_STATUS, refusalHeaders, verdictForToken } from "lib/api/auth";
import { bearerToken } from "lib/auth/githubAuth";
import type { NextApiRequest, NextApiResponse } from "next";

const SELF_URL = process.env.HUD_SELF_URL || "https://hud.pytorch.org";

// The upstream answer's headers that go back with it: its type, how it may
// be kept, and on a refusal how to retry.
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "vary",
  "www-authenticate",
  "retry-after",
];

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Refusals are never stored by a cache, and answer as the API does.
  res.setHeader("Cache-Control", "no-store");
  const token = bearerToken(req);
  if (!token) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return res.status(401).json({
      error: "Authentication required: Authorization: Bearer <token>",
      code: CODE_BY_STATUS[401],
    });
  }
  const verdict = await verdictForToken(token);
  if (!verdict.ok) {
    for (const [name, value] of Object.entries(refusalHeaders(verdict))) {
      res.setHeader(name, value);
    }
    return res
      .status(verdict.status)
      .json({ error: verdict.error, code: CODE_BY_STATUS[verdict.status] });
  }

  const segments = Array.isArray(req.query.path)
    ? req.query.path
    : [req.query.path];
  const subpath = segments.join("/");
  const url = req.url || "";
  const qIndex = url.indexOf("?");
  const qs = qIndex >= 0 ? url.slice(qIndex) : "";
  const callerPath = qIndex >= 0 ? url.slice(0, qIndex) : url;
  const target = `${SELF_URL}/api/${subpath}${qs}`;

  // The routes under app/api run the same gate themselves, so the token goes
  // along; the target is this deployment, which already saw it. The caller's
  // own path goes along too, so the page links in a listing's answer keep
  // this prefix and work for the caller that follows them.
  const init: RequestInit = {
    method: req.method,
    headers: {
      authorization: req.headers.authorization as string,
      ...(callerPath === "" ? {} : { "x-forwarded-path": callerPath }),
    },
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
  res.removeHeader("Cache-Control");
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) {
      res.setHeader(name, value);
    }
  }
  return res.send(text);
}
