import type {
  CommitJob,
  CommitJobTests,
  JobTests,
} from "lib/api/tests/commit/jobs/types";

const at = (time: string) => `2026-11-14T${time}.000Z`;

// A job of GET /api/tests/commit/{sha}/jobs: queued at 5:00, on a runner at
// 5:02 and done at 6:00, in the pull workflow, with no steps of note until
// a test says otherwise.
export function commitJob(
  id: string,
  name: string,
  overrides: Partial<CommitJob> = {},
  workflow = "pull"
): CommitJob {
  return {
    id,
    name,
    url: null,
    workflow: {
      run_id: "7",
      run_attempt: 1,
      name: workflow,
      path: `.github/workflows/${workflow}.yml`,
      event: "push",
    },
    status: "completed",
    conclusion: "success",
    created_at: at("05:00:00"),
    started_at: at("05:02:00"),
    completed_at: at("06:00:00"),
    labels: [],
    container_step: null,
    test_step: null,
    failed_step: null,
    failure_line: null,
    ...overrides,
  };
}

const NO_TESTS = {
  failed: 0,
  timed_out: 0,
  flaky: 0,
  passed: 0,
  other: 0,
  xfailed: 0,
  skipped: 0,
};

// A test job on a runner whose container comes up at 5:03: its Test step
// runs from 5:10 to 5:59 and fails.
export const testJob = commitJob(
  "101",
  "linux-jammy-py3.10-gcc11 / test (default, 1, 2, linux.2xlarge)",
  {
    conclusion: "failure",
    container_step: {
      started_at: at("05:02:05"),
      completed_at: at("05:03:00"),
    },
    test_step: { started_at: at("05:10:00"), completed_at: at("05:59:00") },
    failed_step: "Test",
  }
);

// What its tests did: recorded tests ran for 15 seconds of its Test step.
export const TEST_JOB_TESTS: JobTests = {
  by_status: { ...NO_TESTS, failed: 1, flaky: 2, passed: 40 },
  running: [
    { started_at: at("05:10:00"), ended_at: at("05:10:10") },
    { started_at: at("05:10:50"), ended_at: at("05:10:55") },
  ],
  failing_attempts: { failed: 1, flaky: 1 },
};

// The commit's jobs: a build with its build job and two shards, a job that
// is a build of its own, a workflow too small for a row, and a bot's job.
export const COMMIT_JOBS: CommitJob[] = [
  commitJob("100", "linux-jammy-py3.10-gcc11 / build"),
  testJob,
  commitJob(
    "102",
    "linux-jammy-py3.10-gcc11 / test (default, 2, 2, linux.2xlarge)",
    {
      test_step: { started_at: at("05:10:00"), completed_at: at("05:50:00") },
    }
  ),
  commitJob("103", "lintrunner / linux-job"),
  commitJob(
    "104",
    "quick-checks",
    { started_at: at("05:02:00"), completed_at: at("05:02:30") },
    "lint"
  ),
  commitJob(
    "105",
    "Upload test stats for 43579122301, attempt 1",
    {
      workflow: {
        run_id: "9",
        run_attempt: 1,
        name: "Upload test stats",
        path: ".github/workflows/upload-test-stats.yml",
        event: "workflow_run",
      },
    },
    "upload-test-stats"
  ),
];

// What the tests of the commit's jobs did: the two shards recorded some.
export const COMMIT_TESTS: CommitJobTests[] = [
  { job_id: "101", ...TEST_JOB_TESTS },
  {
    job_id: "102",
    by_status: { ...NO_TESTS, passed: 30, skipped: 5 },
    running: [{ started_at: at("05:10:00"), ended_at: at("05:50:00") }],
    failing_attempts: { failed: 0, flaky: 0 },
  },
];
