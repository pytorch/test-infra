import { queryClickhouseSaved } from "lib/clickhouse";
import { decodeTestIdentity } from "lib/testIdentity";
import type { NextApiRequest, NextApiResponse } from "next";

const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_BUCKET_MS = 60 * 1000;

export interface TestMetricsResponse {
  averageDurationSeconds: number | null;
  totalRuns: number;
  successfulRuns: number;
  failureRuns: number;
  skippedRuns: number;
}

type ErrorResponse = { error: string };

interface TestMetricsQueryRow {
  average_duration_seconds: number | null;
  total_runs: number;
  successful_runs: number;
  failure_runs: number;
  skipped_runs: number;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<TestMetricsResponse | ErrorResponse>
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query.id;
  if (typeof id !== "string") {
    return res.status(400).json({ error: "Invalid test identifier" });
  }

  const test = decodeTestIdentity(id);
  if (!test) {
    return res.status(400).json({ error: "Invalid test identifier" });
  }

  const anchorMs = Math.floor(Date.now() / CACHE_BUCKET_MS) * CACHE_BUCKET_MS;
  const cutoffMs = anchorMs - LOOKBACK_MS;

  try {
    const rows = (await queryClickhouseSaved(
      "test_detail_metrics",
      {
        file: test.file,
        classname: test.classname,
        name: test.name,
        cutoff_ms: cutoffMs,
        anchor_ms: anchorMs,
      },
      true
    )) as TestMetricsQueryRow[];
    const metrics = rows[0];

    return res.status(200).json({
      averageDurationSeconds:
        metrics?.average_duration_seconds == null
          ? null
          : Number(metrics.average_duration_seconds),
      totalRuns: Number(metrics?.total_runs ?? 0),
      successfulRuns: Number(metrics?.successful_runs ?? 0),
      failureRuns: Number(metrics?.failure_runs ?? 0),
      skippedRuns: Number(metrics?.skipped_runs ?? 0),
    });
  } catch (error) {
    console.error("Failed to fetch test metrics", error);
    return res.status(500).json({ error: "Failed to fetch test metrics" });
  }
}
