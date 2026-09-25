import type { RelayHealthJob } from "components/crcr/RelayHealthDetailsDialog";
import {
  isExpectedHealthOutcome,
  isHealthJobPassing,
  workflowJobUrl,
} from "components/crcr/RelayHealthDetailsDialog";
import { readFileSync } from "fs";
import {
  CRCR_HEALTH_STALE_AFTER_MINUTES,
  CRCR_HEALTH_WINDOW_MINUTES,
} from "lib/crcr/healthProbe";
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
  test("uses the health card's time window and stale threshold", () => {
    expect(detailsRecentPrs).toContain(
      "started_at >= now() - INTERVAL {window_minutes: UInt64} MINUTE"
    );
    expect(CRCR_HEALTH_WINDOW_MINUTES).toBeGreaterThan(
      CRCR_HEALTH_STALE_AFTER_MINUTES
    );
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

  test("keeps in-progress xfail probes healthy", () => {
    expect(
      isHealthJobPassing(
        job({
          jobName: "xfail",
          status: "in_progress",
          conclusion: null,
        })
      )
    ).toBe(true);
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
