import { CRCR_ALLOWLIST_CACHE_TTL_MS, CrcrAllowlist } from "lib/crcrAllowlist";
import type { NextApiRequest, NextApiResponse } from "next";

const ALLOWLIST_RAW_URL =
  "https://raw.githubusercontent.com/pytorch/pytorch/main/.github/allowlist.yml";

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

/** Convert a CrcrAllowlist into the AllowlistResponse shape for the API. */
function toResponse(allowlist: CrcrAllowlist): AllowlistResponse {
  const result: AllowlistResponse = { L1: [], L2: [], L3: [], L4: [] };
  for (const entry of allowlist.getEntries()) {
    result[entry.level].push({
      repo: entry.repo,
      oncalls: entry.oncalls,
    });
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
    const allowlist = CrcrAllowlist.fromYaml(text);
    const data = toResponse(allowlist);

    cached = { data, expiry: now + CRCR_ALLOWLIST_CACHE_TTL_MS };
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
