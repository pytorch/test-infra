const HUD_BASE_URL = process.env.HUD_BASE_URL || "https://hud.pytorch.org";
const HUD_BOT_TOKEN = process.env.HUD_BOT_TOKEN;

// Simple in-memory cache: { [url]: { body, contentType, timestamp } }
const cache = new Map();
const CACHE_TTL_MS = 120_000; // 2 minutes

export async function handler(event) {
  const path = event.pathParameters?.proxy || "";
  const qs = event.rawQueryString || "";
  const method =
    event.requestContext?.http?.method || event.httpMethod || "GET";

  const targetUrl = `${HUD_BASE_URL}/${path}${qs ? "?" + qs : ""}`;

  // Serve from cache for GET requests
  if (method === "GET") {
    const cached = cache.get(targetUrl);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
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
