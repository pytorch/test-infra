import type { JobRow, JobTestsRow } from "lib/api/tests/commit/jobs/jobs";

export const SHA = "0123456789abcdef0123456789abcdef01234567";
const at = (time: string) => Date.parse(`2026-11-14T${time}Z`);

// A test job on an ARC runner: its container comes up a minute after
// GitHub's start, and its Test step fails.
export const jobRow: JobRow = {
  id: "101",
  name: "linux-jammy-py3.10-gcc11 / test (default, 1, 2, linux.2xlarge)",
  url: "https://github.com/pytorch/pytorch/actions/runs/7/job/101",
  status: "completed",
  conclusion: "failure",
  created_at_ms: at("05:00:00"),
  started_at_ms: at("05:02:00"),
  completed_at_ms: at("06:00:00"),
  labels: ["linux.2xlarge"],
  step_names: [
    "Set up job",
    "Initialize containers",
    "Test",
    "Test",
    "Teardown",
  ],
  step_conclusions: ["success", "success", "skipped", "failure", "success"],
  step_started_at_ms: [
    at("05:02:00"),
    at("05:02:05"),
    0,
    at("05:10:00"),
    at("05:59:00"),
  ],
  step_completed_at_ms: [
    at("05:02:05"),
    at("05:03:00"),
    0,
    at("05:59:00"),
    at("06:00:00"),
  ],
  failure_line: "AssertionError: boom",
  workflow_run_id: "7",
  workflow_run_attempt: 1,
  workflow_name: "pull",
  workflow_path: ".github/workflows/pull.yml",
  workflow_event: "push",
  head_sha: SHA,
  repo: "pytorch/pytorch",
};

// Slots are 5 seconds: 05:10:00 is slot 358927320.
const SLOT = at("05:10:00") / 5000;
export const testsRow: JobTestsRow = {
  job_id: "101",
  failed: 1,
  timed_out: 0,
  flaky: 2,
  passed: 40,
  other: 0,
  xfailed: 3,
  skipped: 4,
  stretch_first_slots: [SLOT, SLOT + 10],
  stretch_last_slots: [SLOT + 1, SLOT + 10],
  failed_attempts: 3,
  flaky_attempts: 2,
};
