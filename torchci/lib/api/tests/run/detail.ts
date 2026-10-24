import { buildRunDetailQuery } from "lib/api/tests/run/query";
import { RunDetail } from "lib/api/tests/run/types";
import { queryRunAttempts } from "lib/api/tests/test/runs/attempts";
import {
  expandRunRows,
  runGroup,
  RunRow,
} from "lib/api/tests/test/runs/mapping";
import { queryClickhouse } from "lib/clickhouse";

export async function getRun(id: string): Promise<RunDetail | null> {
  const { sql, params } = buildRunDetailQuery(id);
  const queryStartedAt = performance.now();
  const rows: RunRow[] = await queryClickhouse(sql, params, "api_run_detail");
  const queryDurationMs = Math.round(performance.now() - queryStartedAt);
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error("Run ID matched multiple retained runs");
  }
  const groups = [runGroup(rows[0])];
  const attempts = await queryRunAttempts(groups);
  // Retention or a replacement may remove the requested execution between
  // reads. A bundle without that UUID no longer resolves the requested ID.
  if (!attempts.rows.some((row) => row.id === id.toLowerCase())) return null;
  const expanded = await expandRunRows(attempts.rows, groups);
  return {
    run: expanded.runs[0],
    query_duration_ms:
      queryDurationMs + attempts.query_duration_ms + expanded.query_duration_ms,
  };
}
