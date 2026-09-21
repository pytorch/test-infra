import {
  buildNightlyMatrix,
  isRealCommitSha,
  NightlyMatrixJob,
} from "lib/crcr/nightlyMatrix";

function job(overrides: Partial<NightlyMatrixJob> = {}): NightlyMatrixJob {
  return {
    job_name: "build",
    run_id: "89983",
    pytorch_head_sha: "a".repeat(40),
    upstream_repo: "pytorch/pytorch",
    started_at: "2026-09-19T14:36:44Z",
    run_attempt: 1,
    conclusion: "success",
    ...overrides,
  };
}

describe("isRealCommitSha", () => {
  test("accepts a 40-hex commit", () => {
    expect(isRealCommitSha("9f2c1ab4de7708c5" + "0".repeat(24))).toBe(true);
  });

  test.each([
    ["buildkite-89983-01a0ba19-c6f0-41f7-b182-665ada79a292"],
    ["unknown"],
    [""],
    ["a".repeat(39)],
    ["z".repeat(40)],
  ])("rejects %s", (value) => {
    expect(isRealCommitSha(value)).toBe(false);
  });
});

describe("buildNightlyMatrix", () => {
  // The shape production actually had for vllm-project/vllm run 89983: every
  // job carrying a distinct delivery_id in pytorch_head_sha. Grouping on that
  // column turned one 65-job build into 65 single-cell rows.
  test("groups a build into one row even when every job has a distinct sha", () => {
    const data = [
      job({
        job_name: ":docker: Build CPU image",
        pytorch_head_sha: "buildkite-89983-jobA",
      }),
      job({
        job_name: ":docker: Build HPU image",
        pytorch_head_sha: "buildkite-89983-jobB",
      }),
      job({
        job_name: ":nvidia: (B200) Kernels Shard 1",
        pytorch_head_sha: "buildkite-89983-jobC",
      }),
    ];

    const { rows, jobNames } = buildNightlyMatrix(data);

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("89983");
    expect(rows[0].runId).toBe("89983");
    expect(rows[0].jobs.size).toBe(3);
    expect(jobNames).toHaveLength(3);
  });

  test("separates distinct runs when neither has a real commit", () => {
    const { rows } = buildNightlyMatrix([
      job({
        run_id: "89983",
        pytorch_head_sha: "buildkite-89983-a",
        started_at: "2026-09-19T14:36:44Z",
      }),
      job({
        run_id: "89980",
        pytorch_head_sha: "buildkite-89980-a",
        started_at: "2026-09-18T20:51:22Z",
      }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["89983", "89980"]);
  });

  // NVIDIA/pytorch-windows-ci reports 10 commits across 19 runs, and
  // TorchedHat/pytorch-redhat-ci 30 across 73: several workflows test one
  // pytorch nightly and their stages belong on a single row. Keying on run_id
  // unconditionally split every one of those rows in half.
  test("keeps several runs against one commit on a single row", () => {
    const sha = "1ec60e20a915d032f91bf37306fca7d94f93bc01";
    const { rows, jobNames } = buildNightlyMatrix([
      job({ run_id: "rtx-1", pytorch_head_sha: sha, job_name: "rtx-build" }),
      job({ run_id: "rtx-1", pytorch_head_sha: sha, job_name: "rtx-test" }),
      job({ run_id: "woa-2", pytorch_head_sha: sha, job_name: "woa-build" }),
      job({ run_id: "woa-2", pytorch_head_sha: sha, job_name: "woa-test" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(sha);
    expect(rows[0].jobs.size).toBe(4);
    expect(jobNames).toHaveLength(4);
  });

  test("separates distinct commits", () => {
    const { rows } = buildNightlyMatrix([
      job({ pytorch_head_sha: "a".repeat(40), run_id: "1" }),
      job({ pytorch_head_sha: "b".repeat(40), run_id: "2" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  test("orders rows newest run first by latest job start", () => {
    const { rows } = buildNightlyMatrix([
      job({
        run_id: "old",
        pytorch_head_sha: "bk-old",
        started_at: "2026-09-10T00:00:00Z",
      }),
      job({
        run_id: "new",
        pytorch_head_sha: "bk-new",
        started_at: "2026-09-19T00:00:00Z",
      }),
      job({
        run_id: "old",
        pytorch_head_sha: "bk-old",
        job_name: "late",
        started_at: "2026-09-11T00:00:00Z",
      }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["new", "old"]);
    expect(rows[1].latestTime).toBe("2026-09-11T00:00:00Z");
  });

  test("keeps a real commit sha on the row for display", () => {
    const sha = "9f2c1ab4de7708c5" + "0".repeat(24);
    const { rows } = buildNightlyMatrix([job({ pytorch_head_sha: sha })]);
    expect(rows[0].sha).toBe(sha);
    expect(isRealCommitSha(rows[0].sha)).toBe(true);
  });

  test("prefers the later run_attempt for a repeated job name", () => {
    const { rows } = buildNightlyMatrix([
      job({ job_name: "flaky", run_attempt: 1, conclusion: "failure" }),
      job({ job_name: "flaky", run_attempt: 2, conclusion: "success" }),
    ]);
    expect(rows[0].jobs.get("flaky")?.run_attempt).toBe(2);
    expect(rows[0].jobs.get("flaky")?.conclusion).toBe("success");
  });

  // vLLM run 89983 really did have three jobs sharing one label. Grouping by
  // run puts them in a single cell, so the cell must not report success just
  // because a passing shard sorted last.
  test("a failing shard is not hidden behind same-attempt siblings", () => {
    const shards = (conclusions: string[]) =>
      buildNightlyMatrix(
        conclusions.map((conclusion) =>
          job({
            job_name: ":nvidia: Spec Decode AL MTP + Other Acceptance Nightly",
            conclusion,
          })
        )
      ).rows[0].jobs.get(
        ":nvidia: Spec Decode AL MTP + Other Acceptance Nightly"
      )?.conclusion;

    expect(shards(["success", "failure", "success"])).toBe("failure");
    expect(shards(["failure", "success", "success"])).toBe("failure");
    expect(shards(["success", "success", "success"])).toBe("success");
    expect(shards(["success", "timed_out"])).toBe("timed_out");
  });

  test("falls back to the bogus sha when there is no run_id either", () => {
    const { rows } = buildNightlyMatrix([
      job({ run_id: "", pytorch_head_sha: "not-a-sha" }),
    ]);
    expect(rows[0].key).toBe("not-a-sha");
  });

  test("handles an empty result set", () => {
    expect(buildNightlyMatrix([])).toEqual({ jobNames: [], rows: [] });
  });
});
