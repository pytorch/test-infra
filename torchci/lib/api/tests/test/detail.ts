import { readGeneration } from "lib/api/tests/list";
import {
  EntityRow,
  toConfigurationHealth,
  toTest,
} from "lib/api/tests/mapping";
import { HealthWindow, RanOn } from "lib/api/tests/parameters";
import { buildTestDetailQuery } from "lib/api/tests/test/query";
import { TestDetail } from "lib/api/tests/test/types";
import { queryClickhouse } from "lib/clickhouse";

interface TestDetailRow extends EntityRow {
  window: HealthWindow;
  ran_on: RanOn;
}

export async function getTest(id: string): Promise<TestDetail | null> {
  const { sql, params } = buildTestDetailQuery(id);
  const queryStartedAt = performance.now();
  const rows: TestDetailRow[] = await queryClickhouse(
    sql,
    params,
    "api_test_detail"
  );
  // The catalog is the left side of the join: an absent test differs from a
  // known test with no health, which still returns its identity and owners.
  if (rows.length === 0) return null;
  const healthRows = rows.filter((row) => row.has_health === 1);
  const generation =
    healthRows.length === 0
      ? await readGeneration()
      : healthRows[0].refreshed_at;
  const queryDurationMs = Math.round(performance.now() - queryStartedAt);
  return {
    test: toTest(rows[0]),
    owners: rows[0].owners,
    health: healthRows.map((row) =>
      toConfigurationHealth(row, {
        window: row.window,
        ran_on: [row.ran_on],
      })
    ),
    refreshed_at: generation || null,
    query_duration_ms: queryDurationMs,
  };
}
