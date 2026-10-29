import type { ClickHouseSettings } from "@clickhouse/client";
import { queryClickhouse } from "lib/clickhouse";

export type PageDirection = "next" | "previous";

// SQL returns the closest rows in the cursor's direction plus one lookahead.
// Public pages always retain the requested order. Each outgoing cursor uses
// that page's actual edge, so changing limit works in either direction.
export async function paginateRows<
  Row,
  Cursor extends { direction?: PageDirection }
>({
  rows,
  limit,
  cursor,
  createCursor,
  encodeCursor,
  hasRows,
}: {
  rows: Row[];
  limit: number;
  cursor: Cursor | null;
  createCursor: (_row: Row, _direction: PageDirection) => Cursor;
  encodeCursor: (_cursor: Cursor) => string;
  hasRows: (_cursor: Cursor) => Promise<boolean>;
}) {
  const previous = cursor?.direction === "previous";
  const page = rows.slice(0, limit);
  if (previous) page.reverse();
  let nextCursor: Cursor | null = null;
  let previousCursor: Cursor | null = null;
  if (page.length) {
    const first = page[0];
    const last = page[page.length - 1];
    if (rows.length > limit) {
      if (previous) previousCursor = createCursor(first, "previous");
      else nextCursor = createCursor(last, "next");
    }
    if (cursor !== null) {
      // A live cursor alone does not prove any entries remain on the other
      // side. Probe one row with identical filters, without enriching it.
      const opposite = createCursor(
        previous ? last : first,
        previous ? "next" : "previous"
      );
      if (await hasRows(opposite)) {
        if (previous) nextCursor = opposite;
        else previousCursor = opposite;
      }
    }
  }
  return {
    page,
    next_cursor: nextCursor === null ? null : encodeCursor(nextCursor),
    previous_cursor:
      previousCursor === null ? null : encodeCursor(previousCursor),
  };
}

// One page of a sorted list: the page query with its lookahead row, then the
// cursors, probing the opposite direction with the same query at limit 0.
// query_duration_ms sums the individually rounded page and probe durations;
// afterQuery runs inside the page's measured window, for reads that belong to
// the page itself such as an empty page's refresh lookup. Settings, when
// given, go to the page query and to its probe alike: the probe runs the
// page's whole query for one row, so a heavy page has an equally heavy probe
// (app/api/README.md, Heavy queries).
export async function queryPage<
  Row,
  Cursor extends { direction?: PageDirection }
>({
  build,
  queryId,
  cursor,
  limit,
  afterQuery,
  createCursor,
  encodeCursor,
  settings,
}: {
  build: (
    _cursor: Cursor | null,
    _limit: number
  ) => { sql: string; params: Record<string, unknown> };
  queryId: string;
  cursor: Cursor | null;
  limit: number;
  afterQuery?: (_rows: Row[]) => Promise<void>;
  createCursor: (_row: Row, _direction: PageDirection) => Cursor;
  encodeCursor: (_cursor: Cursor) => string;
  settings?: ClickHouseSettings;
}) {
  const { sql, params } = build(cursor, limit);
  const queryStartedAt = performance.now();
  const rows: Row[] = await queryClickhouse(
    sql,
    params,
    queryId,
    undefined,
    settings
  );
  await afterQuery?.(rows);
  const queryDurationMs = Math.round(performance.now() - queryStartedAt);
  let boundaryDurationMs = 0;
  const { page, next_cursor, previous_cursor } = await paginateRows({
    rows,
    limit,
    cursor,
    createCursor,
    encodeCursor,
    hasRows: async (boundary) => {
      const probe = build(boundary, 0);
      const started = performance.now();
      const found = await queryClickhouse(
        probe.sql,
        probe.params,
        `${queryId}_boundary`,
        undefined,
        settings
      );
      boundaryDurationMs = Math.round(performance.now() - started);
      return found.length > 0;
    },
  });
  return {
    page,
    next_cursor,
    previous_cursor,
    query_duration_ms: queryDurationMs + boundaryDurationMs,
  };
}
