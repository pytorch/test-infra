// The module:/oncall: label hierarchy (child -> parent) for /triage/modules,
// read from `label_parents` in pytorch/pytorch's OWNERSHIP.yaml on main.
import yaml from "js-yaml";
import type { LabelParents } from "lib/triage/labelTree";
import type { NextApiRequest, NextApiResponse } from "next";

const OWNERSHIP_RAW_URL =
  "https://raw.githubusercontent.com/pytorch/pytorch/main/OWNERSHIP.yaml";
const CACHE_TTL_MS = 60 * 60 * 1000;

let cached: { data: LabelParents; expiry: number } | null = null;

export function parseLabelParents(text: string): LabelParents {
  const doc = yaml.load(text) as { label_parents?: unknown } | null;
  const raw = doc?.label_parents ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("label_parents is not a mapping");
  }
  const parents: LabelParents = {};
  for (const [child, parent] of Object.entries(raw)) {
    if (typeof parent !== "string") {
      throw new Error(`label_parents["${child}"] is not a label`);
    }
    parents[child] = parent;
  }
  return parents;
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
    const response = await fetch(OWNERSHIP_RAW_URL);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch OWNERSHIP.yaml from GitHub: ${response.status}`
      );
    }
    const data = parseLabelParents(await response.text());
    cached = { data, expiry: now + CACHE_TTL_MS };
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("label_parents fetch error:", message);
    if (cached) {
      res.setHeader("X-Cache", "STALE");
      return res.status(200).json(cached.data);
    }
    return res.status(502).json({ error: message });
  }
}
