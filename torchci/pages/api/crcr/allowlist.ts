import yaml from "js-yaml";
import type { NextApiRequest, NextApiResponse } from "next";

const ALLOWLIST_RAW_URL =
  "https://raw.githubusercontent.com/pytorch/pytorch/main/.github/allowlist.yml";

const CACHE_TTL_MS = 15 * 60 * 1000;

export interface AllowlistEntry {
  repo: string;
  oncalls: string[];
}

export interface AllowlistResponse {
  L1: AllowlistEntry[];
  L2: AllowlistEntry[];
  L3: AllowlistEntry[];
  L4: AllowlistEntry[];
}

let cached: { data: AllowlistResponse; expiry: number } | null = null;

function parseEntry(raw: unknown): AllowlistEntry | null {
  if (typeof raw === "string") {
    const repo = raw.trim().replace(/^\/|\/$/g, "");
    return repo.includes("/") ? { repo, oncalls: [] } : null;
  }
  if (typeof raw === "object" && raw !== null) {
    const [key, val] = Object.entries(raw)[0] ?? [];
    const repo = String(key ?? "")
      .trim()
      .replace(/^\/|\/$/g, "");
    if (!repo.includes("/")) return null;
    const oncalls = val
      ? String(val)
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : [];
    return { repo, oncalls };
  }
  return null;
}

function parseAllowlist(rawYaml: Record<string, unknown>): AllowlistResponse {
  const result: AllowlistResponse = { L1: [], L2: [], L3: [], L4: [] };
  for (const level of ["L1", "L2", "L3", "L4"] as const) {
    const entries = rawYaml[level];
    if (!Array.isArray(entries)) continue;
    for (const raw of entries) {
      const entry = parseEntry(raw);
      if (entry) result[level].push(entry);
    }
  }
  return result;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const now = Date.now();
  if (cached && now < cached.expiry) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cached.data);
  }

  try {
    const response = await fetch(ALLOWLIST_RAW_URL);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch allowlist from GitHub: ${response.status}`
      );
    }
    const text = await response.text();
    const parsed = (yaml.load(text) as Record<string, unknown>) || {};
    const data = parseAllowlist(parsed);

    cached = { data, expiry: now + CACHE_TTL_MS };
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("CRCR allowlist fetch error:", message);
    if (cached) {
      res.setHeader("X-Cache", "STALE");
      return res.status(200).json(cached.data);
    }
    return res.status(502).json({ error: message });
  }
}
