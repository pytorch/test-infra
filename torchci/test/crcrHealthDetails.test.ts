import type { RelayHealthJob } from "components/crcr/RelayHealthDetailsDialog";
import {
  isExpectedHealthOutcome,
  isHealthJobPassing,
  workflowJobUrl,
} from "components/crcr/RelayHealthDetailsDialog";
import { readFileSync } from "fs";
import { CRCR_HEALTH_PR_COUNT } from "lib/crcr/healthProbe";
import path from "path";

const detailsQuery = readFileSync(
  path.resolve(
    __dirname,
    "..",
    "clickhouse_queries",
    "crcr_health_pr_job_details",
    "query.sql"
  ),
  "utf-8"
);
const detailsRecentPrs = detailsQuery.slice(
  0,
  detailsQuery.indexOf("latest_jobs AS")
);
const detailsLatestJobs = detailsQuery.slice(
  detailsQuery.indexOf("latest_jobs AS")
);

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
  test("uses the same latest-five-PR selection as the health card", () => {
    expect(CRCR_HEALTH_PR_COUNT).toBe(5);
    expect(detailsRecentPrs).toContain("ORDER BY max(started_at) DESC");
    expect(detailsRecentPrs).toContain("LIMIT {count: UInt64}");
    expect(detailsRecentPrs).not.toContain("started_at >= now()");
    expect(detailsLatestJobs).not.toContain("started_at >= now()");
  });

  test("accepts expected terminal probe outcomes", () => {
    const expectedJobs = [
      job({ jobName: "xfail", conclusion: "failure" }),
      job({ jobName: "xcancel", conclusion: "cancelled" }),
      job({ jobName: "xtimeout", conclusion: "timed_out" }),
    ];

    expectedJobs.forEach((expectedJob) => {
      expect(isExpectedHealthOutcome(expectedJob)).toBe(true);
      expect(isHealthJobPassing(expectedJob)).toBe(true);
    });
  });

  test("keeps in-progress expected probes healthy", () => {
    const expectedJobs = [
      job({
        jobName: "xfail",
        status: "in_progress",
        conclusion: null,
      }),
      job({
        jobName: "xtimeout",
        status: "in_progress",
        conclusion: null,
        isOverdue: true,
      }),
    ];

    expectedJobs.forEach((expectedJob) => {
      expect(isHealthJobPassing(expectedJob)).toBe(true);
    });
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
