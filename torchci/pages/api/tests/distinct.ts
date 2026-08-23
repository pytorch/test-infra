import { queryClickhouseSaved } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

const PAGE_SIZE = 100;
const QUERY_LIMIT = PAGE_SIZE + 1;
const LOOKBACK_MS = 60 * 24 * 60 * 60 * 1000;
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const CURSOR_CLOCK_SKEW_MS = 60 * 1000;
const CACHE_BUCKET_MS = 60 * 1000;
const CURSOR_VERSION = 3;
const MAX_CURSOR_LENGTH = 16_384;
const MAX_SEARCH_LENGTH = 200;

export interface DistinctTest {
  name: string;
  classname: string;
  file: string;
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
  lastRunNs: string;
  search: string;
  name: string;
  classname: string;
  file: string;
}

type ErrorResponse = { error: string };

interface DistinctTestQueryRow {
  name: string;
  classname: string;
  file: string;
  last_run_ns: string;
}

function nanosecondsToMilliseconds(value: string): number {
  return Number.parseInt(value.slice(0, -6) || "0", 10);
}

function encodeCursor(
  direction: CursorDirection,
  anchorMs: number,
  search: string,
  test: DistinctTestQueryRow
): string {
  const cursor: DistinctTestsCursor = {
    version: CURSOR_VERSION,
    direction,
    anchorMs,
    lastRunNs: test.last_run_ns,
    search,
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
    !Number.isSafeInteger(lastRunMs) ||
    lastRunMs <= (cursor.anchorMs ?? 0) - LOOKBACK_MS ||
    lastRunMs > now + CURSOR_CLOCK_SKEW_MS ||
    typeof search !== "string" ||
    search.length > MAX_SEARCH_LENGTH ||
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
  if (Array.isArray(cursorParam) || Array.isArray(searchParam)) {
    return res.status(400).json({ error: "Invalid query parameters" });
  }

  const requestedSearch = (searchParam ?? "").trim();
  if (requestedSearch.length > MAX_SEARCH_LENGTH) {
    return res.status(400).json({ error: "Search query is too long" });
  }

  let cursor: DistinctTestsCursor | null = null;
  if (cursorParam !== undefined) {
    try {
      cursor = decodeCursor(cursorParam);
    } catch {
      return res.status(400).json({ error: "Invalid cursor" });
    }
  }

  if (cursor && cursor.search !== requestedSearch) {
    return res.status(400).json({ error: "Cursor does not match search" });
  }

  const anchorMs =
    cursor?.anchorMs ??
    Math.floor(Date.now() / CACHE_BUCKET_MS) * CACHE_BUCKET_MS;
  const cutoffMs = anchorMs - LOOKBACK_MS;
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
        cursor_last_run_ns: cursor?.lastRunNs ?? "0",
        cursor_name: cursor?.name ?? "",
        cursor_classname: cursor?.classname ?? "",
        cursor_file: cursor?.file ?? "",
        search,
        cutoff_ms: cutoffMs,
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
    const tests = orderedRows.map(({ last_run_ns: lastRunNs, ...test }) => ({
      ...test,
      lastRun: new Date(nanosecondsToMilliseconds(lastRunNs)).toISOString(),
    }));
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
            ? encodeCursor("forward", anchorMs, search, lastTest)
            : null,
        previousCursor:
          hasPreviousPage && firstTest
            ? encodeCursor("backward", anchorMs, search, firstTest)
            : null,
      },
    });
  } catch (error) {
    console.error("Failed to fetch distinct tests", error);
    return res.status(500).json({ error: "Failed to fetch distinct tests" });
  }
}
