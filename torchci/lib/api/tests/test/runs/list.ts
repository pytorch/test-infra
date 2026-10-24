import { PageDirection, queryPage } from "lib/api/pagination";
import type { ListPageData } from "lib/api/schema";
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

export async function listRuns({
  query,
  cursor,
}: {
  query: RunsListQuery;
  cursor: RunsCursor | null;
}): Promise<ListPageData<RunListPage>> {
  return queryRunsPage({
    build: (cursor, limit) => buildRunsQuery({ ...query, limit }, cursor),
    cursor,
    limit: query.limit,
    keys: runSortKeys(query),
    queryId: "api_test_runs_page",
    createCursor: (values, direction): RunsCursor => ({
      version: 2,
      resource: "test-runs",
      direction,
      query: runsIdentity(query),
      position: { values },
    }),
    encodeCursor: encodeRunsCursor,
  });
}

// A page of bundles: the grouped page query, then every attempt of the
// selected bundles and their shared metadata.
export async function queryRunsPage<
  Cursor extends { direction?: PageDirection }
>({
  build,
  cursor,
  limit,
  keys,
  queryId,
  encodeCursor,
  createCursor,
}: {
  build: (
    _cursor: Cursor | null,
    _limit: number
  ) => { sql: string; params: Record<string, unknown> };
  cursor: Cursor | null;
  limit: number;
  keys: ReturnType<typeof runSortKeys>;
  queryId: string;
  createCursor: (
    _values: (string | null)[],
    _direction: PageDirection
  ) => Cursor;
  encodeCursor: (_cursor: Cursor) => string;
}): Promise<ListPageData<RunListPage>> {
  const paged = await queryPage<RunGroupRow, Cursor>({
    build,
    queryId,
    cursor,
    limit,
    createCursor: (row, direction) =>
      createCursor(
        keys.map((_, index) => row[`sort_${index}`] as string | null),
        direction
      ),
    encodeCursor,
  });
  const groups = paged.page.map(runGroup);
  const attempts = await queryRunAttempts(groups);
  const expanded = await expandRunRows(attempts.rows, groups);
  return {
    runs: expanded.runs,
    // Retention can remove every selected bundle between page discovery and
    // the attempts read. Keep the public empty-page navigation contract.
    next_cursor: expanded.runs.length ? paged.next_cursor : null,
    previous_cursor: expanded.runs.length ? paged.previous_cursor : null,
    query_duration_ms:
      paged.query_duration_ms +
      attempts.query_duration_ms +
      expanded.query_duration_ms,
  };
}
