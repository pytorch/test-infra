import { queryClickhouseSaved } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

const PAGE_SIZE = 100;
const QUERY_LIMIT = PAGE_SIZE + 1;
const AGGREGATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const CURSOR_CLOCK_SKEW_MS = 60 * 1000;
const CACHE_BUCKET_MS = 60 * 1000;
const CURSOR_VERSION = 8;
const MAX_CURSOR_LENGTH = 16_384;
const MAX_SEARCH_LENGTH = 200;

const SORT_FIELDS = [
  "file",
  "classname",
  "name",
  "health",
  "averageDuration",
  "lastRun",
] as const;
type SortField = (typeof SORT_FIELDS)[number];
type SortOrder = "asc" | "desc";

const DEFAULT_SORT_FIELD: SortField = "averageDuration";

function isSortField(value: unknown): value is SortField {
  return typeof value === "string" && SORT_FIELDS.includes(value as SortField);
}

function isSortOrder(value: unknown): value is SortOrder {
  return value === "asc" || value === "desc";
}

function defaultSortOrder(sort: SortField): SortOrder {
  return sort === "health" || sort === "averageDuration" || sort === "lastRun"
    ? "desc"
    : "asc";
}

export type TestHealthStatus =
  | "healthy"
  | "unhealthy"
  | "alwaysSkipped"
  | "noData";

export interface DistinctTest {
  name: string;
  classname: string;
  file: string;
  healthStatus: TestHealthStatus;
  failureRate7d: number | null;
  failureRuns7d: number;
  executedRuns7d: number;
  skippedRuns7d: number;
  averageDurationSeconds: number | null;
  lastRun: string;
}

export interface DistinctTestsApiResponse {
  tests: DistinctTest[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    nextCursor: string | null;
    previousCursor: string | null;
  };
}

type CursorDirection = "forward" | "backward";

interface DistinctTestsCursor {
  version: typeof CURSOR_VERSION;
  direction: CursorDirection;
  anchorMs: number;
  hasAverageDuration: 0 | 1;
  averageDurationMs: number;
  healthSortBucket: 0 | 1 | 2;
  failureRatePpm: number;
  lastRunNs: string;
  search: string;
  sort: SortField;
  order: SortOrder;
  name: string;
  classname: string;
  file: string;
}

type ErrorResponse = { error: string };

interface DistinctTestQueryRow {
  name: string;
  classname: string;
  file: string;
  has_average_duration: number;
  average_duration_ms: number;
  health_sort_bucket: 0 | 1 | 2;
  has_failure_rate: number;
  failure_rate_ppm: number;
  failure_runs_7d: number;
  executed_runs_7d: number;
  skipped_runs_7d: number;
  last_run_ns: string;
}

function nanosecondsToMilliseconds(value: string): number {
  return Number.parseInt(value.slice(0, -6) || "0", 10);
}

function encodeCursor(
  direction: CursorDirection,
  anchorMs: number,
  search: string,
  sort: SortField,
  order: SortOrder,
  test: DistinctTestQueryRow
): string {
  const cursor: DistinctTestsCursor = {
    version: CURSOR_VERSION,
    direction,
    anchorMs,
    hasAverageDuration: test.has_average_duration === 1 ? 1 : 0,
    averageDurationMs: test.average_duration_ms,
    healthSortBucket: test.health_sort_bucket,
    failureRatePpm: test.failure_rate_ppm,
    lastRunNs: test.last_run_ns,
    search,
    sort,
    order,
    name: test.name,
    classname: test.classname,
    file: test.file,
  };

  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): DistinctTestsCursor {
  if (
    value.length === 0 ||
    value.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error("Invalid cursor");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid cursor");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid cursor");
  }

  const cursor = parsed as Partial<DistinctTestsCursor>;
  const now = Date.now();
  const search = cursor.search ?? "";
  const lastRunMs =
    typeof cursor.lastRunNs === "string" && /^\d{1,19}$/.test(cursor.lastRunNs)
      ? nanosecondsToMilliseconds(cursor.lastRunNs)
      : Number.NaN;
  if (
    cursor.version !== CURSOR_VERSION ||
    (cursor.direction !== "forward" && cursor.direction !== "backward") ||
    !Number.isSafeInteger(cursor.anchorMs) ||
    (cursor.anchorMs ?? 0) <= now - CURSOR_TTL_MS ||
    (cursor.anchorMs ?? 0) > now + CURSOR_CLOCK_SKEW_MS ||
    (cursor.hasAverageDuration !== 0 && cursor.hasAverageDuration !== 1) ||
    !Number.isSafeInteger(cursor.averageDurationMs) ||
    (cursor.averageDurationMs ?? -1) < 0 ||
    (cursor.hasAverageDuration === 0 && cursor.averageDurationMs !== 0) ||
    (cursor.healthSortBucket !== 0 &&
      cursor.healthSortBucket !== 1 &&
      cursor.healthSortBucket !== 2) ||
    !Number.isSafeInteger(cursor.failureRatePpm) ||
    (cursor.failureRatePpm ?? -1) < 0 ||
    (cursor.failureRatePpm ?? 0) > 1_000_000 ||
    (cursor.healthSortBucket !== 0 && cursor.failureRatePpm !== 0) ||
    !Number.isSafeInteger(lastRunMs) ||
    lastRunMs <= (cursor.anchorMs ?? 0) - AGGREGATION_WINDOW_MS ||
    lastRunMs > (cursor.anchorMs ?? 0) ||
    typeof search !== "string" ||
    search.length > MAX_SEARCH_LENGTH ||
    !isSortField(cursor.sort) ||
    !isSortOrder(cursor.order) ||
    typeof cursor.name !== "string" ||
    typeof cursor.classname !== "string" ||
    typeof cursor.file !== "string"
  ) {
    throw new Error("Invalid cursor");
  }

  return { ...(cursor as DistinctTestsCursor), search };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<DistinctTestsApiResponse | ErrorResponse>
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const cursorParam = req.query.cursor;
  const searchParam = req.query.q;
  const sortParam = req.query.sort;
  const orderParam = req.query.order;
  if (
    Array.isArray(cursorParam) ||
    Array.isArray(searchParam) ||
    Array.isArray(sortParam) ||
    Array.isArray(orderParam)
  ) {
    return res.status(400).json({ error: "Invalid query parameters" });
  }

  const requestedSearch = (searchParam ?? "").trim();
  if (requestedSearch.length > MAX_SEARCH_LENGTH) {
    return res.status(400).json({ error: "Search query is too long" });
  }

  if (sortParam !== undefined && !isSortField(sortParam)) {
    return res.status(400).json({ error: "Invalid sort field" });
  }
  const sort: SortField = sortParam ?? DEFAULT_SORT_FIELD;

  if (orderParam !== undefined && !isSortOrder(orderParam)) {
    return res.status(400).json({ error: "Invalid sort order" });
  }
  const order: SortOrder = orderParam ?? defaultSortOrder(sort);

  let cursor: DistinctTestsCursor | null = null;
  if (cursorParam !== undefined) {
    try {
      cursor = decodeCursor(cursorParam);
    } catch {
      return res.status(400).json({ error: "Invalid cursor" });
    }
  }

  if (
    cursor &&
    (cursor.search !== requestedSearch ||
      cursor.sort !== sort ||
      cursor.order !== order)
  ) {
    return res.status(400).json({ error: "Cursor does not match query" });
  }

  const anchorMs =
    cursor?.anchorMs ??
    Math.floor(Date.now() / CACHE_BUCKET_MS) * CACHE_BUCKET_MS;
  const cutoffMs = anchorMs - AGGREGATION_WINDOW_MS;
  const search = cursor?.search ?? requestedSearch;
  const direction = cursor?.direction ?? "forward";
  const queryName =
    direction === "backward"
      ? "distinct_tests_backward"
      : "distinct_tests_forward";

  try {
    const rows = (await queryClickhouseSaved(
      queryName,
      {
        has_cursor: cursor === null ? 0 : 1,
        sort_field: sort,
        sort_ascending: order === "asc" ? 1 : 0,
        cursor_has_average_duration: cursor?.hasAverageDuration ?? 0,
        cursor_average_duration_ms: cursor?.averageDurationMs ?? 0,
        cursor_health_sort_bucket: cursor?.healthSortBucket ?? 0,
        cursor_failure_rate_ppm: cursor?.failureRatePpm ?? 0,
        cursor_last_run_ns: cursor?.lastRunNs ?? "0",
        cursor_name: cursor?.name ?? "",
        cursor_classname: cursor?.classname ?? "",
        cursor_file: cursor?.file ?? "",
        search,
        cutoff_ms: cutoffMs,
        anchor_ms: anchorMs,
        limit: QUERY_LIMIT,
      },
      true
    )) as DistinctTestQueryRow[];

    const hasExtraRow = rows.length > PAGE_SIZE;
    const pageRows = rows.slice(0, PAGE_SIZE);
    const orderedRows =
      direction === "backward" ? pageRows.reverse() : pageRows;
    const firstTest = orderedRows[0];
    const lastTest = orderedRows[orderedRows.length - 1];
    const tests = orderedRows.map(
      ({
        has_average_duration: hasAverageDuration,
        average_duration_ms: averageDurationMs,
        health_sort_bucket: healthSortBucket,
        has_failure_rate: hasFailureRate,
        failure_rate_ppm: failureRatePpm,
        failure_runs_7d: failureRuns7d,
        executed_runs_7d: executedRuns7d,
        skipped_runs_7d: skippedRuns7d,
        last_run_ns: lastRunNs,
        ...test
      }) => {
        const failureRuns = Number(failureRuns7d);
        const executedRuns = Number(executedRuns7d);
        const skippedRuns = Number(skippedRuns7d);
        return {
          ...test,
          healthStatus:
            healthSortBucket === 1
              ? ("alwaysSkipped" as const)
              : healthSortBucket === 2
              ? ("noData" as const)
              : failureRuns * 4 > executedRuns
              ? ("unhealthy" as const)
              : ("healthy" as const),
          failureRate7d:
            hasFailureRate === 1 ? Number(failureRatePpm) / 1_000_000 : null,
          failureRuns7d: failureRuns,
          executedRuns7d: executedRuns,
          skippedRuns7d: skippedRuns,
          averageDurationSeconds:
            hasAverageDuration === 1 ? averageDurationMs / 1000 : null,
          lastRun: new Date(nanosecondsToMilliseconds(lastRunNs)).toISOString(),
        };
      }
    );
    const hasPreviousPage =
      tests.length > 0 &&
      (direction === "backward" ? hasExtraRow : cursor !== null);
    const hasNextPage =
      tests.length > 0 &&
      (direction === "backward" ? cursor !== null : hasExtraRow);

    return res.status(200).json({
      tests,
      pageInfo: {
        hasNextPage,
        hasPreviousPage,
        nextCursor:
          hasNextPage && lastTest
            ? encodeCursor("forward", anchorMs, search, sort, order, lastTest)
            : null,
        previousCursor:
          hasPreviousPage && firstTest
            ? encodeCursor("backward", anchorMs, search, sort, order, firstTest)
            : null,
      },
    });
  } catch (error) {
    console.error("Failed to fetch distinct tests", error);
    return res.status(500).json({ error: "Failed to fetch distinct tests" });
  }
}
