import {
  CrcrRunSelectionJob,
  selectCanonicalCrcrJobs,
  selectCanonicalCrcrRuns,
} from "lib/crcr/runSelection";

function job(
  overrides: Partial<CrcrRunSelectionJob> = {}
): CrcrRunSelectionJob {
  return {
    prNumber: 202008,
    headSha: "a".repeat(40),
    downstreamRepo: "torch-spyre/torch-spyre",
    runId: "new-run",
    runAttempt: 1,
    jobKey: "build",
    startedAt: "2026-11-05T10:00:00Z",
    recordId: "new-build",
    ...overrides,
  };
}

describe("selectCanonicalCrcrJobs", () => {
  test("keeps final attempts from one newest downstream run", () => {
    const selected = selectCanonicalCrcrJobs([
      job({
        runId: "old-run",
        jobKey: "build",
        startedAt: "2026-11-05T09:00:00Z",
        recordId: "old-build",
      }),
      job({
        runId: "old-run",
        jobKey: "test",
        runAttempt: 2,
        startedAt: "2026-11-05T10:30:00Z",
        recordId: "old-test-retry",
      }),
      job({ jobKey: "build", recordId: "new-build" }),
      job({
        jobKey: "test",
        startedAt: "2026-11-05T10:05:00Z",
        recordId: "new-test",
      }),
    ]);

    expect(selected.map((job) => job.recordId).sort()).toEqual([
      "new-build",
      "new-test",
    ]);
    expect(selected.every((job) => job.runId === "new-run")).toBe(true);
  });

  test("does not backfill a missing job from an older run", () => {
    const selected = selectCanonicalCrcrJobs([
      job({
        runId: "old-run",
        jobKey: "test",
        startedAt: "2026-11-05T09:00:00Z",
        recordId: "old-test",
      }),
      job({ jobKey: "build", recordId: "new-build" }),
    ]);

    expect(selected.map((job) => job.jobKey)).toEqual(["build"]);
  });

  test("keeps separate canonical runs for separate backends", () => {
    const runs = selectCanonicalCrcrRuns([
      job({ downstreamRepo: "a/backend", recordId: "a" }),
      job({ downstreamRepo: "b/backend", recordId: "b" }),
    ]);

    expect(runs.map((run) => run.downstreamRepo).sort()).toEqual([
      "a/backend",
      "b/backend",
    ]);
  });

  test("breaks equal start-time ties by run ID", () => {
    const selected = selectCanonicalCrcrJobs([
      job({ runId: "run-a", recordId: "a" }),
      job({ runId: "run-b", recordId: "b" }),
    ]);

    expect(selected.map((job) => job.recordId)).toEqual(["b"]);
  });
});
