import { CrcrHudResult, selectHudCrcrResults } from "lib/crcr/hudResults";

interface HudRow extends CrcrHudResult {
  workflow_run_url: string;
}

function row(overrides: Partial<HudRow> = {}): HudRow {
  return {
    pr_number: 202008,
    pytorch_head_sha: "new-head",
    downstream_repo: "torch-spyre/torch-spyre",
    job_name: "build",
    check_run_id: "new-build",
    run_id: "new-run",
    run_attempt: 1,
    started_at: "2026-11-05T10:00:00Z",
    workflow_run_url: "https://example.test/new-run",
    ...overrides,
  };
}

describe("selectHudCrcrResults", () => {
  test("uses only the displayed head and its canonical downstream run", () => {
    const selected = selectHudCrcrResults(
      [
        row({
          pytorch_head_sha: "old-head",
          run_id: "other-head-run",
          job_name: "build",
          check_run_id: "old-head-build",
          started_at: "2026-11-05T11:00:00Z",
          workflow_run_url: "https://example.test/old-head",
        }),
        row({
          run_id: "old-run",
          job_name: "build",
          check_run_id: "old-build",
          started_at: "2026-11-05T09:00:00Z",
          workflow_run_url: "https://example.test/old-run",
        }),
        row({
          run_id: "old-run",
          job_name: "test",
          check_run_id: "old-test-retry",
          run_attempt: 2,
          started_at: "2026-11-05T10:30:00Z",
          workflow_run_url: "https://example.test/old-run",
        }),
        row({ job_name: "build", check_run_id: "new-build" }),
        row({
          job_name: "test",
          check_run_id: "new-test",
          started_at: "2026-11-05T10:05:00Z",
        }),
      ],
      "new-head"
    );

    expect(selected.map((row) => row.check_run_id).sort()).toEqual([
      "new-build",
      "new-test",
    ]);
    expect(
      selected.every(
        (row) => row.workflow_run_url === "https://example.test/new-run"
      )
    ).toBe(true);
  });

  test("does not backfill a missing job from an older run", () => {
    const selected = selectHudCrcrResults(
      [
        row({
          run_id: "old-run",
          job_name: "test",
          check_run_id: "old-test",
          started_at: "2026-11-05T09:00:00Z",
        }),
        row({ job_name: "build", check_run_id: "new-build" }),
      ],
      "new-head"
    );

    expect(selected.map((row) => row.job_name)).toEqual(["build"]);
  });
});
