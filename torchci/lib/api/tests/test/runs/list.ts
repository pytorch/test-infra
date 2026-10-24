import { queryRunAttempts } from "lib/api/tests/test/runs/attempts";
import {
  encodeRunsCursor,
  RunsCursor,
  runsIdentity,
} from "lib/api/tests/test/runs/cursor";
import {
  expandRunRows,
  runGroup,
  RunGroupRow,
} from "lib/api/tests/test/runs/mapping";
import { RunsListQuery } from "lib/api/tests/test/runs/parameters";
import { buildRunsQuery, runSortKeys } from "lib/api/tests/test/runs/query";
import { RunListPage } from "lib/api/tests/test/runs/types";
import { queryClickhouse } from "lib/clickhouse";

export async function listRuns({
  query,
  cursor,
}: {
  query: RunsListQuery;
  cursor: RunsCursor | null;
}): Promise<RunListPage> {
  const { sql, params } = buildRunsQuery(query, cursor);
  return queryRunsPage({
    sql,
    params,
    limit: query.limit,
    keys: runSortKeys(query),
    queryId: "api_test_runs_page",
    encodeCursor: (values) =>
      encodeRunsCursor({
        version: 2,
        resource: "test-runs",
        query: runsIdentity(query),
        position: { values },
      }),
  });
}

export async function queryRunsPage({
  sql,
  params,
  limit,
  keys,
  queryId,
  encodeCursor,
}: {
  sql: string;
  params: Record<string, unknown>;
  limit: number;
  keys: ReturnType<typeof runSortKeys>;
  queryId: string;
  encodeCursor: (_values: (string | null)[]) => string;
}): Promise<RunListPage> {
  const queryStartedAt = performance.now();
  const rows: RunGroupRow[] = await queryClickhouse(sql, params, queryId);
  const queryDurationMs = Math.round(performance.now() - queryStartedAt);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const groups = page.map(runGroup);
  const attempts = await queryRunAttempts(groups);
  const expanded = await expandRunRows(attempts.rows, groups);
  return {
    runs: expanded.runs,
    next_cursor:
      rows.length > limit
        ? encodeCursor(
            keys.map((_, index) => last[`sort_${index}`] as string | null)
          )
        : null,
    query_duration_ms:
      queryDurationMs + attempts.query_duration_ms + expanded.query_duration_ms,
  };
}
