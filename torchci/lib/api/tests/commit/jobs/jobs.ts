import { queryClickhouse } from "lib/api/tests/clickhouse";
import type {
  CommitJobsField,
  CommitJobsQuery,
} from "lib/api/tests/commit/jobs/parameters";
import {
  buildCommitJobsQuery,
  buildJobTestsQuery,
  TEST_SLOT_SECONDS,
} from "lib/api/tests/commit/jobs/query";
import type {
  CommitJob,
  CommitJobs,
  JobTests,
} from "lib/api/tests/commit/jobs/types";
import { commitRunsScope } from "lib/api/tests/commit/query";
import { commitPageUrl } from "lib/api/tests/pages/links";
import { timed } from "lib/api/tests/timed";
import { BUNDLE_STATUSES } from "lib/runOutcomes";

// A row of buildCommitJobsQuery and buildJobQuery: times in Unix
// milliseconds, 0 for none, and the steps as parallel arrays.
export interface JobRow {
  id: string;
  name: string;
  url: string;
  status: string;
  conclusion: string;
  created_at_ms: number;
  started_at_ms: number;
  completed_at_ms: number;
  labels: string[];
  step_names: string[];
  step_conclusions: string[];
  step_started_at_ms: number[];
  step_completed_at_ms: number[];
  failure_line: string;
  workflow_run_id: string;
  workflow_run_attempt: number;
  workflow_name: string;
  workflow_path: string;
  workflow_event: string;
  head_sha: string;
  repo: string;
}

// A row of buildJobTestsQuery: the job's bundles by status, its slots and
// its failing attempts.
export interface JobTestsRow {
  [column: string]: unknown;
  job_id: string;
  stretch_first_slots: number[];
  stretch_last_slots: number[];
  failed_attempts: number;
  flaky_attempts: number;
}

export interface JobStep {
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

const isoOf = (milliseconds: number) =>
  milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
const slotTime = (slot: number) =>
  new Date(Number(slot) * TEST_SLOT_SECONDS * 1000).toISOString();

export function stepsOf(row: JobRow): JobStep[] {
  return row.step_names.map((name, index) => ({
    name,
    conclusion: row.step_conclusions[index] || null,
    started_at: isoOf(Number(row.step_started_at_ms[index])),
    completed_at: isoOf(Number(row.step_completed_at_ms[index])),
  }));
}

// The step of a name that ran, the longest when several did; a step still
// running counts as the longest.
function stepWindow(steps: JobStep[], name: string) {
  let longest: { started_at: string; completed_at: string | null } | null =
    null;
  let longestDuration = -1;
  for (const step of steps) {
    if (step.name !== name || step.conclusion === "skipped") continue;
    if (step.started_at === null) continue;
    const duration =
      step.completed_at === null
        ? Infinity
        : Date.parse(step.completed_at) - Date.parse(step.started_at);
    if (duration > longestDuration) {
      longestDuration = duration;
      longest = {
        started_at: step.started_at,
        completed_at: step.completed_at,
      };
    }
  }
  return longest;
}

// GitHub sets a job's start to its creation, at times a second before it,
// until a runner takes the job. A job that ended with that start and no
// steps waited until it ended.
function startedAt(row: JobRow): string | null {
  const early = Number(row.created_at_ms) - Number(row.started_at_ms);
  const untaken =
    row.status === "completed"
      ? row.step_names.length === 0 && early >= 0 && early <= 1000
      : row.status !== "in_progress";
  return untaken ? null : isoOf(Number(row.started_at_ms));
}

export function toJob(row: JobRow): CommitJob {
  const steps = stepsOf(row);
  const failedStep =
    steps.find((step) => step.conclusion === "failure") ??
    (row.conclusion === "cancelled"
      ? steps.find((step) => step.conclusion === "cancelled")
      : undefined);
  return {
    id: row.id,
    name: row.name,
    url: row.url || null,
    workflow: {
      run_id: row.workflow_run_id,
      run_attempt: Number(row.workflow_run_attempt),
      name: row.workflow_name || null,
      path: row.workflow_path || null,
      event: row.workflow_event || null,
    },
    status: row.status,
    conclusion: row.conclusion || null,
    created_at: new Date(Number(row.created_at_ms)).toISOString(),
    started_at: startedAt(row),
    completed_at: isoOf(Number(row.completed_at_ms)),
    labels: row.labels,
    container_step: stepWindow(steps, "Initialize containers"),
    test_step: stepWindow(steps, "Test"),
    failed_step: failedStep?.name ?? null,
    failure_line: row.failure_line || null,
  };
}

export function toJobTests(row: JobTestsRow): JobTests {
  return {
    by_status: Object.fromEntries(
      BUNDLE_STATUSES.map((status) => [status, Number(row[status])])
    ) as JobTests["by_status"],
    running: row.stretch_first_slots.map((first, index) => ({
      started_at: slotTime(first),
      ended_at: slotTime(Number(row.stretch_last_slots[index]) + 1),
    })),
    failing_attempts: {
      failed: Number(row.failed_attempts),
      flaky: Number(row.flaky_attempts),
    },
  };
}

// Job IDs are decimal strings: the longer is the larger.
const byJobId = (left: JobTestsRow, right: JobTestsRow) =>
  left.job_id.length - right.job_id.length ||
  (left.job_id < right.job_id ? -1 : left.job_id > right.job_id ? 1 : 0);

// The commit's jobs and what their tests did: two reads, each made only for
// the field that needs it, both at once when both are asked for. The test
// runs read every retained run of the commit once, as the summary's counts
// do; the commit page asks for the jobs without them, to draw the jobs
// while the tests are read.
export async function getCommitJobs(
  query: CommitJobsQuery
): Promise<CommitJobs> {
  const asked = (field: CommitJobsField) =>
    query.fields === undefined || query.fields.includes(field);
  const jobsQuery = asked("jobs") ? buildCommitJobsQuery(query) : null;
  const testsQuery = asked("tests")
    ? buildJobTestsQuery(commitRunsScope(query))
    : null;
  const [jobs, tests] = await Promise.all([
    jobsQuery === null
      ? null
      : timed(
          queryClickhouse(
            jobsQuery.sql,
            jobsQuery.params,
            "api_commit_jobs"
          ) as Promise<JobRow[]>
        ),
    testsQuery === null
      ? null
      : timed(
          queryClickhouse(
            testsQuery.sql,
            testsQuery.params,
            "api_commit_jobs_tests"
          ) as Promise<JobTestsRow[]>
        ),
  ]);
  return {
    ...(jobs !== null && { jobs: jobs.result.map(toJob) }),
    ...(tests !== null && {
      tests: [...tests.result]
        .sort(byJobId)
        .map((row) => ({ job_id: row.job_id, ...toJobTests(row) })),
    }),
    hud_url: commitPageUrl(query.repo, query.sha),
    query_duration_ms: (jobs?.duration_ms ?? 0) + (tests?.duration_ms ?? 0),
  };
}
