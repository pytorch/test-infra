import fs from "fs";
import path from "path";

import {
  NightlyMatrixJob,
  paginateNightlyMatrix,
} from "lib/crcr/nightlyMatrix";

const query = fs.readFileSync(
  path.resolve(
    __dirname,
    "..",
    "clickhouse_queries",
    "crcr_nightly_dashboard",
    "query.sql"
  ),
  "utf8"
);
const params = fs.readFileSync(
  path.resolve(
    __dirname,
    "..",
    "clickhouse_queries",
    "crcr_nightly_dashboard",
    "params.json"
  ),
  "utf8"
);
const backendPage = fs.readFileSync(
  path.resolve(__dirname, "..", "pages", "crcr", "[org]", "[repo].tsx"),
  "utf8"
);

type Job = NightlyMatrixJob & { started_at: string };

type AttemptJob = {
  pytorch_head_sha: string;
  run_id: string;
  job_name: string;
  run_attempt: number;
  shard: string;
};

const sha = (suffix: number) =>
  `${"a".repeat(38)}${suffix.toString(16).padStart(2, "0")}`;

function matrixKey(job: AttemptJob): string {
  return /^[0-9a-f]{40}$/i.test(job.pytorch_head_sha)
    ? `sha:${job.pytorch_head_sha}`
    : `run:${job.run_id || job.pytorch_head_sha}`;
}

function latestAttemptJobs(jobs: AttemptJob[]): AttemptJob[] {
  const latestAttempts = new Map<string, number>();
  for (const job of jobs) {
    const key = `${matrixKey(job)}:${job.run_id}:${job.job_name}`;
    latestAttempts.set(
      key,
      Math.max(latestAttempts.get(key) ?? 0, job.run_attempt)
    );
  }
  return jobs.filter(
    (job) =>
      job.run_attempt ===
      latestAttempts.get(`${matrixKey(job)}:${job.run_id}:${job.job_name}`)
  );
}

describe("crcr_nightly_dashboard", () => {
  test("limits logical matrix rows before expanding their jobs", () => {
    const normalized = query.replace(/\s+/g, " ");
    const limitIndex = normalized.indexOf(
      "LIMIT {limit: UInt64} OFFSET {offset: UInt64}"
    );
    const jobsIndex = normalized.lastIndexOf("SELECT upstream_repo");

    expect(normalized).toContain("eligible_matrix_keys AS");
    expect(normalized).toContain("status = 'completed'");
    expect(normalized).toContain(
      "completed_at >= now() - INTERVAL {days: UInt64} DAY"
    );
    expect(normalized).toContain("latest_attempts AS");
    expect(normalized).not.toContain("ROW_NUMBER() OVER");
    expect(normalized).toContain(
      "GROUP BY matrix_key, run_id, job_name"
    );
    expect(normalized).toContain(
      "matrix_key FROM eligible_matrix_keys"
    );
    expect(normalized).toContain(
      "ORDER BY latest_started_at DESC, matrix_key DESC"
    );
    expect(limitIndex).toBeGreaterThan(-1);
    expect(jobsIndex).toBeGreaterThan(limitIndex);
    expect(normalized).not.toContain("LIMIT 500");
  });

  test("keeps every parallel shard at the latest job attempt", () => {
    const jobs: AttemptJob[] = [
      {
        pytorch_head_sha: sha(1),
        run_id: "run-1",
        job_name: "test",
        run_attempt: 1,
        shard: "passing-old",
      },
      {
        pytorch_head_sha: sha(1),
        run_id: "run-1",
        job_name: "test",
        run_attempt: 2,
        shard: "passing",
      },
      {
        pytorch_head_sha: sha(1),
        run_id: "run-1",
        job_name: "test",
        run_attempt: 2,
        shard: "failing",
      },
    ];

    expect(latestAttemptJobs(jobs).map((job) => job.shard).sort()).toEqual([
      "failing",
      "passing",
    ]);
  });

  test("uses a run key to discard stale retries without a real SHA", () => {
    const jobs: AttemptJob[] = [
      {
        pytorch_head_sha: "delivery-id-attempt-1",
        run_id: "run-1",
        job_name: "test",
        run_attempt: 1,
        shard: "stale-failure",
      },
      {
        pytorch_head_sha: "delivery-id-attempt-2",
        run_id: "run-1",
        job_name: "test",
        run_attempt: 2,
        shard: "latest-success",
      },
    ];

    expect(latestAttemptJobs(jobs).map((job) => job.shard)).toEqual([
      "latest-success",
    ]);
  });

  test("keeps every job for a selected nightly while paging matrix rows", () => {
    const jobs: Job[] = Array.from({ length: 65 }, (_, index) => ({
      job_name: `job-${index}`,
      run_id: "latest-run",
      pytorch_head_sha: sha(1),
      started_at: "2026-10-06T12:00:00Z",
      run_attempt: 1,
    }));

    for (let index = 2; index <= 101; index += 1) {
      jobs.push({
        job_name: "test",
        run_id: `run-${index}`,
        pytorch_head_sha: sha(index),
        started_at: `2026-10-05T${String(23 - (index % 24)).padStart(
          2,
          "0"
        )}:00:00Z`,
        run_attempt: 1,
      });
    }

    const matrix = paginateNightlyMatrix(jobs, 100);

    expect(matrix.hasNextPage).toBe(true);
    expect(matrix.rows).toHaveLength(100);
    expect(matrix.rows[0].jobs.size).toBe(65);
  });

  test("requests one extra matrix row to determine whether another page exists", () => {
    expect(params).toContain('"limit": "UInt64"');
    expect(params).toContain('"offset": "UInt64"');
    expect(backendPage).toContain("NIGHTLY_ROWS_PER_PAGE = 100");
    expect(backendPage).toContain("NIGHTLY_QUERY_ROW_LIMIT");
    expect(backendPage).toContain("Showing nightly matrix rows");
  });
});
