import { buildPrMatrix, PrMatrixJob } from "lib/crcr/prMatrix";

interface Job extends PrMatrixJob {
  workflow_run_url: string;
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    upstream_repo: "pytorch/pytorch",
    pr_number: 202008,
    pytorch_head_sha: "a".repeat(40),
    job_name: "linux-x86_64 / pytorch / build",
    run_id: "new-run",
    run_attempt: 1,
    started_at: "2026-11-05T10:00:00Z",
    workflow_run_url: "https://example.test/new-run",
    ...overrides,
  };
}

describe("buildPrMatrix", () => {
  test("keeps every displayed job in the newest workflow run", () => {
    const { rows } = buildPrMatrix([
      job({
        run_id: "old-run",
        job_name: "linux-x86_64 / pytorch / build",
        started_at: "2026-11-05T09:00:00Z",
        workflow_run_url: "https://example.test/old-run",
      }),
      job({
        run_id: "old-run",
        job_name: "linux-x86_64 / pytorch / test",
        run_attempt: 2,
        started_at: "2026-11-05T10:30:00Z",
        workflow_run_url: "https://example.test/old-run",
      }),
      job({
        job_name: "linux-x86_64 / pytorch / build",
        started_at: "2026-11-05T10:00:00Z",
      }),
      job({
        job_name: "linux-x86_64 / pytorch / test",
        started_at: "2026-11-05T10:05:00Z",
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].runId).toBe("new-run");
    expect(rows[0].jobs.get("linux-x86_64 / pytorch / build")?.run_id).toBe(
      "new-run"
    );
    expect(rows[0].jobs.get("linux-x86_64 / pytorch / test")?.run_id).toBe(
      "new-run"
    );
    expect(
      Array.from(rows[0].jobs.values()).every(
        (selected) =>
          selected.workflow_run_url === "https://example.test/new-run"
      )
    ).toBe(true);
  });

  test("does not backfill a missing job from an older run", () => {
    const { rows } = buildPrMatrix([
      job({
        run_id: "old-run",
        job_name: "linux-x86_64 / pytorch / build",
        started_at: "2026-11-05T09:00:00Z",
        workflow_run_url: "https://example.test/old-run",
      }),
      job({
        run_id: "old-run",
        job_name: "linux-x86_64 / pytorch / test",
        run_attempt: 2,
        started_at: "2026-11-05T10:30:00Z",
        workflow_run_url: "https://example.test/old-run",
      }),
      job({
        job_name: "linux-x86_64 / pytorch / build",
        started_at: "2026-11-05T10:00:00Z",
      }),
    ]);

    expect(rows[0].runId).toBe("new-run");
    expect(rows[0].jobs.get("linux-x86_64 / pytorch / test")).toBeUndefined();
  });
});
