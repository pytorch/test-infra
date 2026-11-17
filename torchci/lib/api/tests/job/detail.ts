import { queryClickhouse } from "lib/api/tests/clickhouse";
import {
  JobRow,
  JobTestsRow,
  stepsOf,
  toJob,
  toJobTests,
} from "lib/api/tests/commit/jobs/jobs";
import {
  buildJobQuery,
  buildJobTestsQuery,
} from "lib/api/tests/commit/jobs/query";
import type { JobDetailQuery } from "lib/api/tests/job/parameters";
import { buildJobFilesQuery, jobRunsScope } from "lib/api/tests/job/query";
import type { JobDetail, JobTestFile } from "lib/api/tests/job/types";
import { commitPageUrl } from "lib/api/tests/pages/links";
import { timed } from "lib/api/tests/timed";
import { BUNDLE_STATUSES } from "lib/runOutcomes";

// A row of buildJobFilesQuery: one report of one test file.
export interface JobFileRow {
  [column: string]: unknown;
  file: string;
  first_started_at: string;
  last_ended_at: string;
  executed_attempts: number;
  failed_attempts: number;
  flaky_attempts: number;
}

// The files in the order they first ran, each with its reports as runs.
export function toFiles(rows: JobFileRow[]): JobTestFile[] {
  const files = new Map<string, JobTestFile>();
  for (const row of rows) {
    let file = files.get(row.file);
    if (file === undefined) {
      file = {
        file: row.file || null,
        tests_by_status: Object.fromEntries(
          BUNDLE_STATUSES.map((status) => [status, 0])
        ) as JobTestFile["tests_by_status"],
        runs: [],
        failing_attempts: { failed: 0, flaky: 0 },
      };
      files.set(row.file, file);
    }
    for (const status of BUNDLE_STATUSES) {
      file.tests_by_status[status] += Number(row[status]);
    }
    file.runs.push({
      started_at: row.first_started_at,
      ended_at: row.last_ended_at,
      status:
        Number(row.failed_attempts) > 0
          ? "failed"
          : Number(row.flaky_attempts) > 0
          ? "flaky"
          : Number(row.executed_attempts) === 0
          ? "skipped"
          : "passed",
    });
    file.failing_attempts.failed += Number(row.failed_attempts);
    file.failing_attempts.flaky += Number(row.flaky_attempts);
  }
  return [...files.values()];
}

// One job, its steps and its test files: null for a job HUD does not know.
// Three reads made at once, each of one job's rows.
export async function getJobDetail({
  job_id: jobId,
}: JobDetailQuery): Promise<JobDetail | null> {
  const jobQuery = buildJobQuery(jobId);
  const testsQuery = buildJobTestsQuery(jobRunsScope(jobId));
  const filesQuery = buildJobFilesQuery(jobId);
  const [job, tests, files] = await Promise.all([
    timed(
      queryClickhouse(jobQuery.sql, jobQuery.params, "api_job") as Promise<
        JobRow[]
      >
    ),
    timed(
      queryClickhouse(
        testsQuery.sql,
        testsQuery.params,
        "api_job_tests"
      ) as Promise<JobTestsRow[]>
    ),
    timed(
      queryClickhouse(
        filesQuery.sql,
        filesQuery.params,
        "api_job_files"
      ) as Promise<JobFileRow[]>
    ),
  ]);
  const row = job.result[0];
  if (row === undefined) return null;
  const testsRow = tests.result[0];
  return {
    job: toJob(row),
    tests: testsRow === undefined ? null : toJobTests(testsRow),
    steps: stepsOf(row),
    files: toFiles(files.result),
    hud_url:
      row.repo === "" || row.head_sha === ""
        ? null
        : commitPageUrl(row.repo, row.head_sha, { job_id: jobId }),
    query_duration_ms: job.duration_ms + tests.duration_ms + files.duration_ms,
  };
}
