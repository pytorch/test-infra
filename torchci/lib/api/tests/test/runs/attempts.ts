import { buildRunAttemptsQuery } from "lib/api/tests/test/runs/attempts-query";
import { RunRow } from "lib/api/tests/test/runs/mapping";
import { RunGroup } from "lib/api/tests/test/runs/types";
import { queryClickhouse } from "lib/clickhouse";

export async function queryRunAttempts(groups: readonly RunGroup[]): Promise<{
  rows: RunRow[];
  query_duration_ms: number;
}> {
  if (groups.length === 0) return { rows: [], query_duration_ms: 0 };
  const { sql, params } = buildRunAttemptsQuery(groups);
  const startedAt = performance.now();
  const rows: RunRow[] = await queryClickhouse(sql, params, "api_run_attempts");
  return {
    rows,
    query_duration_ms: Math.round(performance.now() - startedAt),
  };
}
