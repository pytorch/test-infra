import type { ClickHouseSettings } from "@clickhouse/client";
import { buildRunAttemptsQuery } from "lib/api/tests/test/runs/attempts-query";
import { RunRow } from "lib/api/tests/test/runs/mapping";
import { RunGroup } from "lib/api/tests/test/runs/types";
import { queryClickhouse } from "lib/clickhouse";

// Every attempt of the given bundles. The settings come from the caller: a
// list page's read covers each selected configuration's whole retained history
// through FINAL, up to tens of CPU-seconds on a big commit, so the lists send
// the heavy profile, while the run detail reads one bundle and sends none.
export async function queryRunAttempts(
  groups: readonly RunGroup[],
  settings?: ClickHouseSettings
): Promise<{
  rows: RunRow[];
  query_duration_ms: number;
}> {
  if (groups.length === 0) return { rows: [], query_duration_ms: 0 };
  const { sql, params } = buildRunAttemptsQuery(groups);
  const startedAt = performance.now();
  const rows: RunRow[] = await queryClickhouse(
    sql,
    params,
    "api_run_attempts",
    undefined,
    settings
  );
  return {
    rows,
    query_duration_ms: Math.round(performance.now() - startedAt),
  };
}
