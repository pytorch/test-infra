import { checkAuthWithApiToken } from "lib/auth/auth";
import { queryClickhouse } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

const MAX_PR_NUMBERS = 50;

const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

// Row ordering must stay identical to greenlight's own reader
// (greenlight/src/greenlight/state.py): writer and reader have to agree on which row
// is authoritative. There is deliberately no head_sha filter — it would collapse "no
// verdict for this commit" and "verdict for an older commit" into the same empty
// result, and could resurrect a verdict that a later review superseded.
//
// The shadow exclusion is the one deliberate divergence from that reader, which stays
// unfiltered so its dedup and next_run_id still see every row. A shadow evaluation
// carries no authority, and run_id climbs with every dispatch, so without the exclusion
// a shadow row written after a real verdict outranks it and becomes what pytorch's
// land-time merge gate acts on. It belongs in WHERE, ahead of LIMIT 1 BY, so the
// collapse never picks a shadow row to begin with.
const QUERY = `
SELECT pr_number, status, head_sha, run_id, version
FROM misc.greenlight_pr_state
WHERE repo = {repo: String}
  AND pr_number IN {pr_numbers: Array(Int64)}
  AND shadow = false
ORDER BY pr_number, run_id DESC, version DESC
LIMIT 1 BY pr_number
`;

interface GreenlightPRState {
  pr_number: number;
  status: string;
  head_sha: string;
  run_id: number;
  version: string;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsePrNumbers(raw: string): number[] | null {
  const prNumbers: number[] = [];
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (!/^\d+$/.test(trimmed)) {
      return null;
    }
    const prNumber = Number(trimmed);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
      return null;
    }
    prNumbers.push(prNumber);
  }
  return prNumbers;
}

function toIsoUtc(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const raw = String(value).trim();
  // ClickHouse only appends a zone suffix under date_time_output_format "iso", and
  // Date() reads a zone-less string as machine-local time. The column is UTC, so pin
  // the zone before parsing rather than inheriting whatever the runtime is set to.
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(raw)
    ? raw
    : `${raw.replace(" ", "T")}Z`;
  const parsed = new Date(zoned);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Unparsable greenlight_pr_state version: ${raw}`);
  }
  return parsed.toISOString();
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await checkAuthWithApiToken(req, res);
  if (!auth.ok) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const repo = firstParam(req.query.repo);
  const rawPrNumbers = firstParam(req.query.prNumbers);
  if (!repo || !rawPrNumbers) {
    return res
      .status(400)
      .json({ error: "Missing required params: repo, prNumbers" });
  }

  if (!REPO_RE.test(repo)) {
    return res.status(400).json({ error: "repo must be owner/name" });
  }

  const prNumbers = parsePrNumbers(rawPrNumbers);
  if (prNumbers === null) {
    return res.status(400).json({
      error: "prNumbers must be a comma-separated list of positive integers",
    });
  }
  if (prNumbers.length > MAX_PR_NUMBERS) {
    return res
      .status(400)
      .json({ error: `prNumbers accepts at most ${MAX_PR_NUMBERS} entries` });
  }

  try {
    // useQueryCache is deliberately left off: this gates merges, and ClickHouse's
    // 1-minute result cache would let a superseded verdict authorize a land.
    const rows = await queryClickhouse(
      QUERY,
      { repo, pr_numbers: Array.from(new Set(prNumbers)) },
      "greenlight_pr_state"
    );
    const states: GreenlightPRState[] = rows.map((row: any) => ({
      pr_number: Number(row.pr_number),
      status: row.status,
      head_sha: row.head_sha,
      run_id: Number(row.run_id),
      version: toIsoUtc(row.version),
    }));
    return res
      .setHeader("Cache-Control", "no-store")
      .status(200)
      .json({ states });
  } catch (error) {
    console.error("greenlight pr_state handler error:", error);
    return res
      .status(500)
      .json({ error: "Failed to read greenlight PR state" });
  }
}
