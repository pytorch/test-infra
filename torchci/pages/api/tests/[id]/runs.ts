import { queryClickhouseSaved } from "lib/clickhouse";
import {
  DEFAULT_TEST_HISTORY_RANGE,
  getTestHistoryRange,
  parseTestHistoryRange,
  TEST_HISTORY_RANGE_OPTIONS,
  TestHistoryRange,
} from "lib/testHistory";
import { decodeTestIdentity } from "lib/testIdentity";
import type { NextApiRequest, NextApiResponse } from "next";

const PAGE_SIZE = 20;
const QUERY_LIMIT = PAGE_SIZE + 1;
const CACHE_BUCKET_MS = 60 * 1000;
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const CURSOR_CLOCK_SKEW_MS = 60 * 1000;
const CURSOR_VERSION = 4;
const MAX_TEST_ID_LENGTH = 8_192;
const MAX_CURSOR_LENGTH = 16_384;
const MAX_OFFSET = PAGE_SIZE * 5_000;

export type TestRunStatus = "success" | "failure" | "skipped" | "flaky";

export interface TestRun {
  status: TestRunStatus;
  durationSeconds: number;
  recordedAt: string;
  startedAt: string | null;
  jobId: string;
  jobName: string | null;
  jobUrl: string | null;
  workflowId: string;
  workflowRunAttempt: number;
  workflowName: string | null;
  repository: string | null;
  headBranch: string | null;
  headSha: string | null;
}

export interface TestRunsResponse {
  runs: TestRun[];
  pageInfo: {
    page: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    nextCursor: string | null;
    previousCursor: string | null;
  };
}

interface TestRunsCursor {
  version: typeof CURSOR_VERSION;
  anchorMs: number;
  offset: number;
  testId: string;
  excludeSkipped: boolean;
  range: TestHistoryRange;
}

interface TestRunQueryRow {
  status: TestRunStatus;
  duration_seconds: number;
  recorded_at_ns: string;
  started_at_ns: string | null;
  job_id: string;
  job_name: string | null;
  job_url: string | null;
  workflow_id: string;
  workflow_run_attempt: number;
  workflow_name: string | null;
  repository: string | null;
  head_branch: string | null;
  head_sha: string | null;
}

type ErrorResponse = { error: string };

function encodeCursor(
  anchorMs: number,
  offset: number,
  testId: string,
  excludeSkipped: boolean,
  range: TestHistoryRange
): string {
  const cursor: TestRunsCursor = {
    version: CURSOR_VERSION,
    anchorMs,
    offset,
    testId,
    excludeSkipped,
    range,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string, testId: string): TestRunsCursor {
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

  const cursor = parsed as Partial<TestRunsCursor>;
  const now = Date.now();
  if (
    cursor.version !== CURSOR_VERSION ||
    !Number.isSafeInteger(cursor.anchorMs) ||
    (cursor.anchorMs ?? 0) <= now - CURSOR_TTL_MS ||
    (cursor.anchorMs ?? 0) > now + CURSOR_CLOCK_SKEW_MS ||
    !Number.isSafeInteger(cursor.offset) ||
    (cursor.offset ?? -1) < 0 ||
    (cursor.offset ?? 0) % PAGE_SIZE !== 0 ||
    (cursor.offset ?? 0) > MAX_OFFSET ||
    cursor.testId !== testId ||
    typeof cursor.excludeSkipped !== "boolean" ||
    !TEST_HISTORY_RANGE_OPTIONS.some((option) => option.value === cursor.range)
  ) {
    throw new Error("Invalid cursor");
  }

  return cursor as TestRunsCursor;
}

function nanosecondsToIso(value: string): string {
  const milliseconds = Number.parseInt(value.slice(0, -6) || "0", 10);
  return new Date(milliseconds).toISOString();
}

function nullableNanosecondsToIso(value: string | null): string | null {
  if (!value) return null;
  return nanosecondsToIso(value);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<TestRunsResponse | ErrorResponse>
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query.id;
  const cursorParam = req.query.cursor;
  const excludeSkippedParam = req.query.exclude_skipped;
  const rangeParam = req.query.range;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > MAX_TEST_ID_LENGTH ||
    Array.isArray(cursorParam) ||
    Array.isArray(excludeSkippedParam) ||
    Array.isArray(rangeParam) ||
    (excludeSkippedParam !== undefined &&
      excludeSkippedParam !== "true" &&
      excludeSkippedParam !== "false")
  ) {
    return res.status(400).json({ error: "Invalid query parameters" });
  }

  const excludeSkipped = excludeSkippedParam === "true";
  const range =
    rangeParam === undefined
      ? DEFAULT_TEST_HISTORY_RANGE
      : parseTestHistoryRange(rangeParam);
  if (range === null) {
    return res.status(400).json({ error: "Invalid time range" });
  }

  const test = decodeTestIdentity(id);
  if (!test) {
    return res.status(400).json({ error: "Invalid test identifier" });
  }

  let cursor: TestRunsCursor | null = null;
  if (cursorParam !== undefined) {
    try {
      cursor = decodeCursor(cursorParam, id);
    } catch {
      return res.status(400).json({ error: "Invalid cursor" });
    }
  }

  if (
    cursor &&
    (cursor.excludeSkipped !== excludeSkipped || cursor.range !== range)
  ) {
    return res.status(400).json({ error: "Cursor does not match filters" });
  }

  const anchorMs =
    cursor?.anchorMs ??
    Math.floor(Date.now() / CACHE_BUCKET_MS) * CACHE_BUCKET_MS;
  const cutoffMs = anchorMs - getTestHistoryRange(range).durationMs;
  const offset = cursor?.offset ?? 0;

  try {
    const rows = (await queryClickhouseSaved(
      "test_detail_runs",
      {
        file: test.file,
        classname: test.classname,
        name: test.name,
        cutoff_ms: cutoffMs,
        anchor_ms: anchorMs,
        exclude_skipped: excludeSkipped ? 1 : 0,
        limit: QUERY_LIMIT,
        offset,
      },
      true
    )) as TestRunQueryRow[];

    const hasNextPage = rows.length > PAGE_SIZE && offset < MAX_OFFSET;
    const pageRows = rows.slice(0, PAGE_SIZE);
    const hasPreviousPage = offset > 0;
    const runs = pageRows.map((row) => ({
      status: row.status,
      durationSeconds: Number(row.duration_seconds),
      recordedAt: nanosecondsToIso(row.recorded_at_ns),
      startedAt: nullableNanosecondsToIso(row.started_at_ns),
      jobId: row.job_id,
      jobName: row.job_name,
      jobUrl: row.job_url,
      workflowId: row.workflow_id,
      workflowRunAttempt: Number(row.workflow_run_attempt),
      workflowName: row.workflow_name,
      repository: row.repository,
      headBranch: row.head_branch,
      headSha: row.head_sha,
    }));

    return res.status(200).json({
      runs,
      pageInfo: {
        page: offset / PAGE_SIZE + 1,
        hasNextPage,
        hasPreviousPage,
        nextCursor: hasNextPage
          ? encodeCursor(
              anchorMs,
              offset + PAGE_SIZE,
              id,
              excludeSkipped,
              range
            )
          : null,
        previousCursor: hasPreviousPage
          ? encodeCursor(
              anchorMs,
              Math.max(0, offset - PAGE_SIZE),
              id,
              excludeSkipped,
              range
            )
          : null,
      },
    });
  } catch (error) {
    console.error("Failed to fetch test runs", error);
    return res.status(500).json({ error: "Failed to fetch test runs" });
  }
}
