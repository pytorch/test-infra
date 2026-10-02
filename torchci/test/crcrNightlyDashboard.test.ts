import { readFileSync } from "fs";
import path from "path";

const query = readFileSync(
  path.resolve(
    __dirname,
    "..",
    "clickhouse_queries",
    "crcr_nightly_dashboard",
    "query.sql"
  ),
  "utf-8"
);

type NightlyJob = {
  sha: string;
  runId: string;
  jobName: string;
  runAttempt: number;
  status: string;
  completedAt: string;
};

const realSha = (suffix: string) => `${"a".repeat(39)}${suffix}`;

function nightlyKey(job: NightlyJob): string {
  if (/^[0-9a-f]{40}$/i.test(job.sha)) {
    return `sha:${job.sha}`;
  }
  return `run:${job.runId || job.sha}`;
}

function dashboardJobs(
  jobs: NightlyJob[],
  start: string,
  stop: string
): NightlyJob[] {
  const eligibleKeys = new Set(
    jobs
      .filter(
        (job) =>
          job.status === "completed" &&
          job.completedAt >= start &&
          job.completedAt < stop
      )
      .map(nightlyKey)
  );
  const selected = jobs.filter((job) => eligibleKeys.has(nightlyKey(job)));
  const latestAttempts = new Map<string, number>();

  for (const job of selected) {
    const key = `${job.sha}:${job.runId}:${job.jobName}`;
    latestAttempts.set(
      key,
      Math.max(latestAttempts.get(key) ?? 0, job.runAttempt)
    );
  }

  return selected.filter(
    (job) =>
      job.runAttempt ===
      latestAttempts.get(`${job.sha}:${job.runId}:${job.jobName}`)
  );
}

describe("CRCR nightly dashboard selection", () => {
  const start = "2026-09-24T00:00:00Z";
  const stop = "2026-10-01T00:00:00Z";

  test("returns every job for a SHA when one sibling completed in range", () => {
    const selected = dashboardJobs(
      [
        {
          sha: realSha("1"),
          runId: "build-run",
          jobName: "build",
          runAttempt: 1,
          status: "completed",
          completedAt: "2026-09-20T00:00:00Z",
        },
        {
          sha: realSha("1"),
          runId: "test-run",
          jobName: "test",
          runAttempt: 1,
          status: "completed",
          completedAt: "2026-09-30T10:00:00Z",
        },
        {
          sha: realSha("2"),
          runId: "other-run",
          jobName: "other",
          runAttempt: 1,
          status: "completed",
          completedAt: "2026-09-20T00:00:00Z",
        },
      ],
      start,
      stop
    );

    expect(selected.map((job) => job.jobName).sort()).toEqual([
      "build",
      "test",
    ]);
  });

  test("keeps run-level completeness when a reporter has no upstream SHA", () => {
    const selected = dashboardJobs(
      [
        {
          sha: "delivery-build",
          runId: "run-1",
          jobName: "build",
          runAttempt: 1,
          status: "completed",
          completedAt: "2026-09-30T10:00:00Z",
        },
        {
          sha: "delivery-test",
          runId: "run-1",
          jobName: "test",
          runAttempt: 1,
          status: "completed",
          completedAt: "2026-09-20T00:00:00Z",
        },
      ],
      start,
      stop
    );

    expect(selected.map((job) => job.jobName).sort()).toEqual([
      "build",
      "test",
    ]);
  });

  test("keeps only the latest retry for each selected workflow job", () => {
    const selected = dashboardJobs(
      [
        {
          sha: realSha("3"),
          runId: "run-1",
          jobName: "test",
          runAttempt: 1,
          status: "completed",
          completedAt: "2026-09-30T10:00:00Z",
        },
        {
          sha: realSha("3"),
          runId: "run-1",
          jobName: "test",
          runAttempt: 2,
          status: "completed",
          completedAt: "2026-09-23T10:00:00Z",
        },
      ],
      start,
      stop
    );

    expect(selected).toHaveLength(1);
    expect(selected[0].runAttempt).toBe(2);
  });

  test("keeps the query aligned with SHA-level eligibility", () => {
    const normalized = query.replace(/\s+/g, " ");

    expect(normalized).toContain("eligible_nightly_keys AS");
    expect(normalized).toContain("status = 'completed'");
    expect(normalized).toContain(
      "completed_at >= now() - INTERVAL {days: UInt64} DAY"
    );
    expect(normalized).toContain(
      "nightly_key IN (SELECT nightly_key FROM eligible_nightly_keys)"
    );
    expect(normalized).toContain("GROUP BY pytorch_head_sha, run_id, job_name");
    expect(normalized).toContain(
      "(pytorch_head_sha, run_id, job_name, run_attempt) IN"
    );
  });
});
