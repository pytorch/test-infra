import {
  encodeCursor,
  listIdentity,
  TestListCursor,
} from "lib/api/tests/cursor";
import { CI_DATABASE } from "lib/api/tests/database";
import { EntityRow, toEntry } from "lib/api/tests/mapping";
import { TestListQuery } from "lib/api/tests/parameters";
import { buildListQuery, sortKeys } from "lib/api/tests/query";
import { TestListPage } from "lib/api/tests/types";
import { queryClickhouse } from "lib/clickhouse";

// Empty results have no health row from which to read a generation. Observe
// the current generation afterward; a refresh may have occurred in between.
export async function readGeneration(): Promise<string> {
  const rows = await queryClickhouse(
    `SELECT refreshed_at FROM ${CI_DATABASE}.health LIMIT 1`,
    {},
    "api_tests_generation"
  );
  return rows[0]?.refreshed_at ?? "";
}

type ListRequest = { query: TestListQuery; cursor: TestListCursor | null };

export async function listTests({
  query,
  cursor,
}: ListRequest): Promise<TestListPage> {
  const { sql, params } = buildListQuery(query, cursor);
  const queryStartedAt = performance.now();
  const rows: EntityRow[] = await queryClickhouse(
    sql,
    params,
    "api_tests_page"
  );
  // A nonempty page reports the generation of the rows it actually read.
  // Cursors track positions in live data and remain usable after refreshes.
  const generation =
    rows.length === 0 ? await readGeneration() : rows[0].refreshed_at;
  const queryDurationMs = Math.round(performance.now() - queryStartedAt);
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  const next_cursor =
    rows.length > query.limit
      ? encodeCursor({
          version: 1,
          resource: "tests",
          query: listIdentity(query),
          generation,
          position: {
            values: sortKeys(query).map(
              (_, index) => last[`sort_${index}`] as string | number | null
            ),
          },
        })
      : null;
  return {
    tests: page.map((row) => toEntry(row, query)),
    next_cursor,
    refreshed_at: generation || null,
    query_duration_ms: queryDurationMs,
  };
}
