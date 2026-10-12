import { queryClickhouseSaved } from "lib/clickhouse";
import { buildDemotionStatuses } from "lib/crcr/demotionStatus";
import { formatMeasured, L3SummaryRow } from "lib/crcr/l3Readiness";
import { L3_DEMOTION_WINDOW_DAYS } from "lib/crcr/l3Thresholds";
import { fetchCrcrAllowlist } from "lib/crcrAllowlist";
import { getOctokit } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";

interface LevelStatusRepo {
  repo: string;
  level: "L3";
  /** The level change the criteria call for, if any. */
  change: "demote" | null;
  /** No PR jobs at all over the window. */
  noData: boolean;
  /** The window `criteria` were measured over. */
  windowDays: number;
  /** Formatted as on /crcr; `met` is null when there is no data to judge. */
  criteria: {
    criterion: string;
    measured: string;
    target: string;
    met: boolean | null;
  }[];
}

interface LevelStatusResponse {
  repos: LevelStatusRepo[];
}

/**
 * Which backends should change level, by the same criteria /crcr shows. The
 * CRCR sync level workflow (tools/torchci/crcr_sync_level.py) opens and closes
 * the allowlist PRs from it.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const allowlist = await fetchCrcrAllowlist(
      await getOctokit("pytorch", "pytorch")
    );
    const rows: L3SummaryRow[] = await queryClickhouseSaved("crcr_l3_summary", {
      days: L3_DEMOTION_WINDOW_DAYS,
    });
    const l3Repos = allowlist
      .getEntries()
      .filter((entry) => entry.level === "L3")
      .map((entry) => entry.repo);
    const statuses = buildDemotionStatuses(
      l3Repos,
      new Map(rows.map((row) => [row.repo, row]))
    );
    const body: LevelStatusResponse = {
      repos: statuses.map((status) => ({
        repo: status.repo,
        level: "L3",
        // Silence (no jobs at all) is listed on /crcr but never opens a PR.
        change: status.onTemporaryDemotion && !status.noData ? "demote" : null,
        noData: status.noData,
        windowDays: L3_DEMOTION_WINDOW_DAYS,
        criteria: status.rows.map((row) => ({
          criterion: row.criterion,
          measured: formatMeasured(row),
          target: row.targetLabel,
          met: row.verdict,
        })),
      })),
    };
    return res.status(200).json(body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("CRCR level status error:", message);
    return res.status(500).json({ error: message });
  }
}
