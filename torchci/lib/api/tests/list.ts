import { queryPage } from "lib/api/pagination";
import type { ListPageData } from "lib/api/schema";
import {
  encodeCursor,
  listIdentity,
  TestListCursor,
} from "lib/api/tests/cursor";
import { CI_DATABASE, CI_WORKLOAD_HEAVY } from "lib/api/tests/database";
import { EntityRow, toEntry } from "lib/api/tests/mapping";
import { testsPageLink } from "lib/api/tests/pages/links";
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
}: ListRequest): Promise<ListPageData<TestListPage>> {
  // A nonempty page reports the generation of the rows it actually read.
  // Cursors track positions in live data and remain usable after refreshes.
  let generation = "";
  const keys = sortKeys(query);
  const { page, next_cursor, previous_cursor, query_duration_ms } =
    await queryPage<EntityRow, TestListCursor>({
      build: (cursor, limit) => buildListQuery({ ...query, limit }, cursor),
      queryId: "api_tests_page",
      // The page aggregates a whole health partition, seconds of CPU per
      // request, so it and its probe run in the heavy workload; the
      // generation lookup above reads one row and stays outside it.
      settings: CI_WORKLOAD_HEAVY,
      cursor,
      limit: query.limit,
      afterQuery: async (rows) => {
        generation =
          rows.length === 0 ? await readGeneration() : rows[0].refreshed_at;
      },
      createCursor: (row, direction) => ({
        version: 1,
        resource: "tests",
        direction,
        query: listIdentity(query),
        generation,
        position: {
          values: keys.map(
            (_, index) => row[`sort_${index}`] as string | number | null
          ),
        },
      }),
      encodeCursor,
    });
  return {
    tests: page.map((row) => toEntry(row, query)),
    next_cursor,
    previous_cursor,
    // The page that shows this selection, or null when the request used a
    // parameter the page has no equivalent for (pages/links.ts).
    hud_url: testsPageLink(query),
    refreshed_at: generation || null,
    query_duration_ms,
  };
}
