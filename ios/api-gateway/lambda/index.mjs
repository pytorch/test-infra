import { gzipSync } from "node:zlib";

const HUD_BASE_URL = process.env.HUD_BASE_URL || "https://hud.pytorch.org";
const HUD_BOT_TOKEN = process.env.HUD_BOT_TOKEN;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

// Simple in-memory cache: { [url]: { body, contentType, timestamp } }
const cache = new Map();
const CACHE_TTL_MS = 120_000; // 2 minutes
const CACHE_MAX_ENTRIES = 200;

function evictStaleCache() {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > CACHE_TTL_MS) cache.delete(key);
  }
  // If still over limit, remove oldest entries
  if (cache.size > CACHE_MAX_ENTRIES) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < sorted.length - CACHE_MAX_ENTRIES; i++) {
      cache.delete(sorted[i][0]);
    }
  }
}

// AWS Lambda has a 6 MB synchronous response payload limit.
// Gzip-compress responses larger than this threshold to stay under the limit.
const COMPRESS_THRESHOLD = 1_000_000; // 1 MB

function compressResponse(body, contentType) {
  if (body.length > COMPRESS_THRESHOLD) {
    const compressed = gzipSync(Buffer.from(body, "utf-8"));
    return {
      statusCode: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Encoding": "gzip",
        "Access-Control-Allow-Origin": "*",
        "X-Cache": "MISS",
      },
      body: compressed.toString("base64"),
      isBase64Encoded: true,
    };
  }
  return null;
}

// API Gateway HTTP API v2 decodes %2F in rawPath, so
// /api/clickhouse/build_time_metrics%2Foverall becomes
// /api/clickhouse/build_time_metrics/overall.
// The HUD ClickHouse API expects the query name as a single path segment
// (e.g. /api/clickhouse/build_time_metrics%2Foverall), so we must re-encode
// the slash in the query name portion of the path.
function fixClickHousePath(path) {
  const clickhousePrefix = "api/clickhouse/";
  if (path.startsWith(clickhousePrefix)) {
    const queryName = path.slice(clickhousePrefix.length);
    // Re-encode any slashes in the query name (they were %2F originally)
    return clickhousePrefix + queryName.replace(/\//g, "%2F");
  }
  return path;
}

async function handleGitHubTokenExchange(event) {
  if (!GITHUB_CLIENT_SECRET) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "GitHub OAuth not configured" }),
    };
  }

  try {
    const body = event.isBase64Encoded
      ? JSON.parse(Buffer.from(event.body, "base64").toString())
      : JSON.parse(event.body);

    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: body.client_id,
        client_secret: GITHUB_CLIENT_SECRET,
        code: body.code,
        redirect_uri: body.redirect_uri,
      }),
    });

    const data = await response.json();
    if (data.error) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: data.error, error_description: data.error_description }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ access_token: data.access_token }),
    };
  } catch (error) {
    console.error("GitHub token exchange error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Token exchange failed" }),
    };
  }
}

export async function handler(event) {
  const rawPath = event.rawPath || "";
  let path = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
  const qs = event.rawQueryString || "";
  const method =
    event.requestContext?.http?.method || event.httpMethod || "GET";

  // Fix ClickHouse query names that contain slashes (decoded by API Gateway)
  path = fixClickHousePath(path);

  // Handle GitHub OAuth token exchange
  if (path === "api/auth/github/token" && method === "POST") {
    return handleGitHubTokenExchange(event);
  }

  const targetUrl = `${HUD_BASE_URL}/${path}${qs ? "?" + qs : ""}`;

  // Serve from cache for GET requests
  if (method === "GET") {
    const cached = cache.get(targetUrl);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      const compressed = compressResponse(cached.body, cached.contentType);
      if (compressed) {
        compressed.headers["X-Cache"] = "HIT";
        return compressed;
      }
      return {
        statusCode: 200,
        headers: {
          "Content-Type": cached.contentType,
          "Access-Control-Allow-Origin": "*",
          "X-Cache": "HIT",
        },
        body: cached.body,
      };
    }
  }

  const headers = {
    Accept: "application/json",
    "x-hud-internal-bot": HUD_BOT_TOKEN,
  };

  const authHeader =
    event.headers?.authorization || event.headers?.Authorization;
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  try {
    const fetchOptions = { method, headers };

    if (method === "POST" && event.body) {
      headers["Content-Type"] =
        event.headers?.["content-type"] || "application/json";
      fetchOptions.body = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString()
        : event.body;
    }

    const response = await fetch(targetUrl, fetchOptions);
    const body = await response.text();
    const contentType =
      response.headers.get("content-type") || "application/json";

    // Cache successful GET responses
    if (method === "GET" && response.status >= 200 && response.status < 300) {
      cache.set(targetUrl, { body, contentType, timestamp: Date.now() });
      evictStaleCache();
    }

    // Compress large responses to stay under Lambda's 6MB payload limit
    if (response.status >= 200 && response.status < 300) {
      const compressed = compressResponse(body, contentType);
      if (compressed) {
        compressed.statusCode = response.status;
        return compressed;
      }
    }

    return {
      statusCode: response.status,
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "X-Cache": "MISS",
      },
      body,
    };
  } catch (error) {
    console.error("Proxy error:", error);
    return {
      statusCode: 502,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Failed to proxy request to HUD API" }),
    };
  }
}
