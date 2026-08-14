import { JobStatus } from "components/job/GroupJobConclusion";
import { mergeCellRuns } from "lib/mergeCellRuns";
import { JobData } from "lib/types";
import nock from "nock";

nock.disableNetConnect();

function run(id: string, conclusion: string, runOrigin?: string): JobData {
  return { id, conclusion, runOrigin, name: "w / j", sha: "abc" };
}

describe("mergeCellRuns", () => {
  test("a single run is shown as-is, whoever issued it", () => {
    for (const origin of [undefined, "autorevert", "retry"]) {
      const only = run("1", JobStatus.Failure, origin);
      const merged = mergeCellRuns([only]);
      expect(merged.conclusion).toBe(JobStatus.Failure);
      // No merge annotations on a one-run cell.
      expect(merged.mergedRunCount).toBeUndefined();
      expect(merged.mergedRuns).toBeUndefined();
      expect(merged.failedPreviousRun).toBe(false);
    }
  });

  test("a one-run cell is a copy, and a stale flag on it cannot render a phantom F", () => {
    const poisoned: JobData = {
      id: "1",
      conclusion: JobStatus.Success,
      failedPreviousRun: true,
      name: "w / j",
    };
    const merged = mergeCellRuns([poisoned]);
    expect(merged.failedPreviousRun).toBe(false);
    // A copy, so the caller's later `job.name = undefined` cannot mutate the input row.
    expect(merged).not.toBe(poisoned);
    expect(poisoned.name).toBe("w / j");
  });

  // The invariant: the verdict depends on the SET of conclusions, never on the issuer and never on
  // the order. Every permutation below must agree.
  test("success + failure renders flaky regardless of order or issuer", () => {
    const cases: JobData[][] = [
      [run("1", JobStatus.Failure), run("2", JobStatus.Success, "autorevert")],
      [run("2", JobStatus.Success, "autorevert"), run("1", JobStatus.Failure)],
      // The case the old newest-id-wins reducer got wrong: natural run passed, the LATER restart
      // failed. It used to render a plain red with no flaky marker.
      [run("1", JobStatus.Success), run("2", JobStatus.Failure, "autorevert")],
      [run("2", JobStatus.Failure, "autorevert"), run("1", JobStatus.Success)],
      // Same thing for a plain re-run attempt.
      [run("1", JobStatus.Success), run("2", JobStatus.Failure, "retry")],
      // And for two push runs, e.g. a periodic scheduled twice.
      [run("1", JobStatus.Failure), run("2", JobStatus.Success)],
    ];
    for (const runs of cases) {
      const merged = mergeCellRuns(runs);
      expect(merged.conclusion).toBe(JobStatus.Success);
      expect(merged.failedPreviousRun).toBe(true);
    }
  });

  test("timed_out counts as a real failure", () => {
    const merged = mergeCellRuns([
      run("1", JobStatus.Success),
      run("2", JobStatus.Timed_out, "autorevert"),
    ]);
    expect(merged.conclusion).toBe(JobStatus.Success);
    expect(merged.failedPreviousRun).toBe(true);
  });

  test("only failures stays a failure, and is not marked flaky", () => {
    const merged = mergeCellRuns([
      run("1", JobStatus.Failure),
      run("2", JobStatus.Failure, "autorevert"),
    ]);
    expect(merged.conclusion).toBe(JobStatus.Failure);
    expect(merged.failedPreviousRun).toBe(false);
  });

  test("cancelled loses to any non-cancelled run, in either order", () => {
    for (const runs of [
      [
        run("1", JobStatus.Cancelled),
        run("2", JobStatus.Success, "autorevert"),
      ],
      [
        run("2", JobStatus.Success, "autorevert"),
        run("1", JobStatus.Cancelled),
      ],
      // Cancelled is newer here, so newest-id-wins used to surface the cancellation.
      [
        run("1", JobStatus.Success),
        run("2", JobStatus.Cancelled, "autorevert"),
      ],
    ]) {
      const merged = mergeCellRuns(runs);
      expect(merged.conclusion).toBe(JobStatus.Success);
    }
    const withFailure = mergeCellRuns([
      run("1", JobStatus.Cancelled),
      run("2", JobStatus.Failure),
    ]);
    expect(withFailure.conclusion).toBe(JobStatus.Failure);
  });

  test("a cancelled run is not failure evidence, so it does not make a success flaky", () => {
    // Deliberate, confirmed divergence from isFailure(), which counts cancelled as a failure. Moves
    // 223 cells over 14 days of pytorch/pytorch from "F" to a plain success. This test exists to stop
    // that being "fixed" back: a run rule 3 discards must not also turn a success flaky.
    const merged = mergeCellRuns([
      run("1", JobStatus.Cancelled),
      run("2", JobStatus.Success, "autorevert"),
    ]);
    expect(merged.conclusion).toBe(JobStatus.Success);
    expect(merged.failedPreviousRun).toBe(false);
  });

  test("all-cancelled has nothing better to fall back to", () => {
    const merged = mergeCellRuns([
      run("1", JobStatus.Cancelled),
      run("2", JobStatus.Cancelled, "autorevert"),
    ]);
    expect(merged.conclusion).toBe(JobStatus.Cancelled);
  });

  // Rule 3 says ANY non-cancelled run wins, not just success/failure. Ranking cancelled rather than
  // filtering it made it beat skipped and neutral.
  test.each([
    JobStatus.Success,
    JobStatus.Failure,
    JobStatus.Timed_out,
    JobStatus.Neutral,
    JobStatus.Skipped,
    JobStatus.Queued,
    JobStatus.Pending,
  ])("cancelled loses to %s in both orders", (other) => {
    expect(
      mergeCellRuns([run("1", JobStatus.Cancelled), run("2", other)]).conclusion
    ).toBe(other);
    expect(
      mergeCellRuns([run("2", other), run("1", JobStatus.Cancelled)]).conclusion
    ).toBe(other);
  });

  test("an empty conclusion is treated as pending, not as an unknown class", () => {
    // hud_query maps '' to queued/pending before this point; this pins the defensive normalization so
    // '' can never outrank or underrank a real result by accident.
    expect(
      mergeCellRuns([run("1", ""), run("2", JobStatus.Cancelled)]).conclusion
    ).toBe("");
    const withSkip = mergeCellRuns([run("1", ""), run("2", JobStatus.Skipped)]);
    expect(withSkip.conclusion).toBe("");
  });

  test("the failing run stays reachable from a flaky cell", () => {
    const failing: JobData = {
      id: "2",
      conclusion: JobStatus.Failure,
      htmlUrl: "https://example.com/failed-run",
      name: "w / j",
    };
    const merged = mergeCellRuns([run("1", JobStatus.Success), failing]);
    // The success represents the cell, so without this the failure has no route from the grid.
    expect(merged.conclusion).toBe(JobStatus.Success);
    expect(merged.failedPreviousRun).toBe(true);
    expect(merged.mergedFailureUrl).toBe("https://example.com/failed-run");
  });

  test("no failure url is invented when the representative IS the failure", () => {
    const merged = mergeCellRuns([
      run("1", JobStatus.Skipped),
      { id: "2", conclusion: JobStatus.Failure, htmlUrl: "u", name: "w / j" },
    ]);
    expect(merged.conclusion).toBe(JobStatus.Failure);
    expect(merged.mergedFailureUrl).toBeUndefined();
  });

  test("an unrecognized origin is reported verbatim rather than called a push", () => {
    const merged = mergeCellRuns([
      run("1", JobStatus.Success, "schedule"),
      run("2", JobStatus.Failure),
    ]);
    expect(merged.mergedRuns).toBe("schedule: success, push: failure");
  });

  test("skipped keeps losing to a real result", () => {
    const merged = mergeCellRuns([
      run("2", JobStatus.Skipped),
      run("1", JobStatus.Failure, "autorevert"),
    ]);
    expect(merged.conclusion).toBe(JobStatus.Failure);
  });

  test("a completed result outranks a still-pending run", () => {
    const merged = mergeCellRuns([
      run("2", JobStatus.Pending, "autorevert"),
      run("1", JobStatus.Success),
    ]);
    expect(merged.conclusion).toBe(JobStatus.Success);
  });

  test("restart-only cells report their real conclusion, including red", () => {
    // Under the previous success-only SQL filter these rows never reached the grid at all.
    expect(
      mergeCellRuns([run("1", JobStatus.Failure, "autorevert")]).conclusion
    ).toBe(JobStatus.Failure);
    expect(
      mergeCellRuns([run("1", JobStatus.Skipped, "autorevert")]).conclusion
    ).toBe(JobStatus.Skipped);
  });

  test("the representative within a class is the newest run", () => {
    const merged = mergeCellRuns([
      run("10", JobStatus.Success),
      run("20", JobStatus.Success, "autorevert"),
    ]);
    expect(merged.id).toBe("20");
  });

  test("merge annotations report the count and every origin", () => {
    const merged = mergeCellRuns([
      run("1", JobStatus.Failure),
      run("2", JobStatus.Success, "autorevert"),
      run("3", JobStatus.Cancelled, "retry"),
    ]);
    expect(merged.mergedRunCount).toBe(3);
    expect(merged.mergedRuns).toBe(
      "autorevert restart: success, push: failure, re-run attempt: cancelled"
    );
  });

  test("a stale failedPreviousRun on an input row cannot leak into a clean cell", () => {
    const poisoned: JobData = {
      id: "1",
      conclusion: JobStatus.Success,
      failedPreviousRun: true,
      name: "w / j",
    };
    const merged = mergeCellRuns([poisoned, run("2", JobStatus.Success)]);
    expect(merged.failedPreviousRun).toBe(false);
  });

  test("an empty cell merges to an empty job rather than throwing", () => {
    expect(mergeCellRuns([])).toEqual({});
  });
});
