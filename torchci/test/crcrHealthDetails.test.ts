import {
  isExpectedHealthOutcome,
  isHealthJobPassing,
  workflowJobUrl,
} from "components/crcr/RelayHealthDetailsDialog";
import type { RelayHealthJob } from "components/crcr/RelayHealthDetailsDialog";

function job(overrides: Partial<RelayHealthJob> = {}): RelayHealthJob {
  return {
    jobName: "linux-build",
    status: "completed",
    conclusion: "success",
    startedAt: "2026-09-18T00:00:00Z",
    workflowRunUrl: "https://github.com/pytorch/crcr-test/actions/runs/1",
    checkRunId: "2",
    ...overrides,
  };
}

describe("CRCR health details", () => {
  test("keeps expected probe failures out of triage failures", () => {
    const expectedFailure = job({
      jobName: "xtimeout",
      conclusion: "timed_out",
    });

    expect(isExpectedHealthOutcome(expectedFailure)).toBe(true);
    expect(isHealthJobPassing(expectedFailure)).toBe(true);
  });

  test("treats unfinished probe jobs as needing attention", () => {
    expect(
      isHealthJobPassing(job({ status: "in_progress", conclusion: null }))
    ).toBe(false);
  });

  test("links directly to the Actions job when its ID is available", () => {
    expect(workflowJobUrl(job())).toBe(
      "https://github.com/pytorch/crcr-test/actions/runs/1/job/2"
    );
  });
});
