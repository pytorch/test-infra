import { JobStatus } from "components/job/GroupJobConclusion";
import {
  describeCellRun,
  describeRunOrigin,
  detailJobForRun,
  mergeCellRuns,
  runKeyOf,
} from "lib/mergeCellRuns";
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
      // No run list on a one-run cell -- the cell already describes it.
      expect(merged.cellRuns).toBeUndefined();
      expect(merged.failedPreviousRun).toBeUndefined();
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
    expect(merged.failedPreviousRun).toBeUndefined();
    // Deleted, not assigned false -- `false` is not null, so fetchHud's strip would ship it.
    expect("failedPreviousRun" in merged).toBe(false);
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
    expect(merged.failedPreviousRun).toBeUndefined();
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
    expect(merged.failedPreviousRun).toBeUndefined();
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

  test("the failing run stays reachable from a flaky cell, with its own log", () => {
    const failing: JobData = {
      id: "2",
      conclusion: JobStatus.Failure,
      htmlUrl: "https://example.com/failed-run",
      logUrl: "https://example.com/failed-log",
      failureLines: ["boom"],
      failureCaptures: ["boom"],
      name: "w / j",
    };
    const merged = mergeCellRuns([run("1", JobStatus.Success), failing]);
    // The success represents the cell, so without the run list the failure has no route from the
    // grid -- and its LOG has none even with a route, because the log url is per-run.
    expect(merged.conclusion).toBe(JobStatus.Success);
    expect(merged.failedPreviousRun).toBe(true);
    const failedRun = merged.cellRuns!.find(
      (r) => r.conclusion === JobStatus.Failure
    )!;
    expect(failedRun.htmlUrl).toBe("https://example.com/failed-run");
    expect(failedRun.logUrl).toBe("https://example.com/failed-log");
    expect(failedRun.failureLines).toEqual(["boom"]);
    expect(failedRun.isRepresentative).toBeUndefined();
  });

  // The 197-cell bug: the restart LOST the ranking (rule 2 makes the success the representative),
  // so every restart identity field was dropped and the tooltip called the cell a push -- on exactly
  // the population the provenance feature exists to explain.
  test("restart identity survives even when the restart is not the representative", () => {
    const restart: JobData = {
      id: "2",
      conclusion: JobStatus.Failure,
      runOrigin: "autorevert",
      restartDispatchedBy: "pytorch-auto-revert[bot]",
      restartRerunBy: "huydhn",
      restartRunAttempt: 2,
      name: "w / j",
    };
    const merged = mergeCellRuns([run("1", JobStatus.Success), restart]);
    // The cell itself is the push run, and says so.
    expect(merged.runOrigin).toBeUndefined();
    expect(merged.restartDispatchedBy).toBeUndefined();
    const restartRun = merged.cellRuns!.find(
      (r) => r.runOrigin === "autorevert"
    )!;
    expect(restartRun.restartDispatchedBy).toBe("pytorch-auto-revert[bot]");
    expect(restartRun.restartRerunBy).toBe("huydhn");
    expect(restartRun.restartRunAttempt).toBe(2);
    expect(describeCellRun(restartRun)).toBe(
      "autorevert restart (attempt 2), dispatched by pytorch-auto-revert[bot], rerun by huydhn — failure"
    );
  });

  // An ordinary GitHub re-run is named, but carries NO attempt number: hud_query deliberately does
  // not project the job's own run_attempt, because the HUD page reads `runAttempt` when merging crcr
  // rows and depends on it being undefined here. Only the restart's attempt is available.
  test("a re-run attempt is named without an attempt number it does not have", () => {
    const rerun: JobData = {
      id: "2",
      conclusion: JobStatus.Failure,
      runOrigin: "retry",
      // Set on the input row on purpose: it must NOT reach the run line, because on the real HUD
      // path it is always undefined and a number here would be a fiction on some other surface.
      runAttempt: 3,
      name: "w / j",
    };
    const merged = mergeCellRuns([run("1", JobStatus.Success), rerun]);
    expect(merged.cellRuns!.map(describeCellRun)).toEqual([
      "push — success",
      "re-run attempt — failure",
    ]);
    // And the restart's attempt is not confused for it.
    expect(
      describeCellRun({
        runOrigin: "autorevert",
        restartRunAttempt: 2,
        conclusion: JobStatus.Failure,
      })
    ).toBe("autorevert restart (attempt 2) — failure");
  });

  test("an unrecognized origin is reported verbatim rather than called a push", () => {
    const merged = mergeCellRuns([
      run("1", JobStatus.Success, "schedule"),
      run("2", JobStatus.Failure),
    ]);
    expect(merged.cellRuns!.map(describeCellRun)).toEqual([
      "schedule — success",
      "push — failure",
    ]);
  });

  // The blank is NOT the same claim as the absent value: workflow_event is a dictGet that returns
  // the column default until the dictionary catches up, so blanks land on the freshest rows on the
  // page. Calling those "push" is a guess; rendering them raw produced "Shown run: ." on the grid.
  test("a blank origin reads as unknown, while an absent one is a push", () => {
    expect(describeRunOrigin({ runOrigin: undefined })).toBe("push");
    expect(describeRunOrigin({ runOrigin: "" })).toBe("unknown");
    expect(describeRunOrigin({ runOrigin: "   " })).toBe("unknown");
    expect(describeRunOrigin({ runOrigin: " schedule " })).toBe("schedule");
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

  test("the representative within a class is the newest run, compared numerically", () => {
    // Ids where lexical and numeric order DISAGREE: "9" > "10" as strings. The reducer this
    // replaced compared them as strings, so equal-digit ids could not tell the two apart.
    const merged = mergeCellRuns([
      run("9", JobStatus.Success),
      run("10", JobStatus.Success, "autorevert"),
    ]);
    expect(merged.id).toBe("10");
  });

  test("the run list carries every run, best class first, representative marked", () => {
    const merged = mergeCellRuns([
      run("1", JobStatus.Failure),
      run("2", JobStatus.Success, "autorevert"),
      run("3", JobStatus.Cancelled, "retry"),
    ]);
    expect(merged.cellRuns).toHaveLength(3);
    expect(merged.cellRuns!.map(describeCellRun)).toEqual([
      "autorevert restart — success",
      "push — failure",
      "re-run attempt — cancelled",
    ]);
    // Exactly one representative, and it is the run the cell renders -- so the list can never
    // disagree with the cell about which run supplied its duration and default links.
    const marked = merged.cellRuns!.filter((r) => r.isRepresentative);
    expect(marked).toHaveLength(1);
    expect(marked[0].id).toBe(merged.id);
    expect(marked[0].id).toBe("2");
  });

  test("the run list order does not depend on the order the query returned rows in", () => {
    const runs = [
      run("1", JobStatus.Failure),
      run("2", JobStatus.Success, "autorevert"),
      run("3", JobStatus.Skipped),
    ];
    const forward = mergeCellRuns(runs)!.cellRuns!.map((r) => r.id);
    const reversed = mergeCellRuns(runs.slice().reverse())!.cellRuns!.map(
      (r) => r.id
    );
    expect(forward).toEqual(reversed);
  });

  // The tail of a long list is collapsed in the UI, so burying either the representative or the
  // failure would hide exactly what the reader opened the tooltip for.
  test("the list leads with the representative, then failures, then the rest newest-first", () => {
    const merged = mergeCellRuns([
      run("10", JobStatus.Success),
      run("40", JobStatus.Success), // newest success -> representative
      run("20", JobStatus.Failure),
      run("30", JobStatus.Skipped),
      run("50", JobStatus.Failure), // newer failure
    ]);
    expect(merged.id).toBe("40");
    expect(merged.cellRuns!.map((r) => r.id)).toEqual([
      "40", // representative first
      "50", // then failures, newest first
      "20",
      "30", // then the rest, newest first
      "10",
    ]);
    expect(merged.cellRuns![0].isRepresentative).toBe(true);
  });

  test("runs with equal or missing ids still produce a stable, complete list", () => {
    // hud_query has no ORDER BY, so input order is not controlled -- and a comparator that returns 0
    // would leave the outcome to sort stability, i.e. to the query.
    const a: JobData = {
      conclusion: JobStatus.Failure,
      htmlUrl: "aaa",
      name: "w / j",
    };
    const b: JobData = {
      conclusion: JobStatus.Failure,
      htmlUrl: "bbb",
      name: "w / j",
    };
    const forward = mergeCellRuns([a, b]);
    const reversed = mergeCellRuns([b, a]);
    expect(forward.cellRuns).toHaveLength(2);
    expect(forward.cellRuns!.map((r) => r.htmlUrl)).toEqual(
      reversed.cellRuns!.map((r) => r.htmlUrl)
    );
    expect(forward.htmlUrl).toBe(reversed.htmlUrl);
    expect(forward.cellRuns!.filter((r) => r.isRepresentative)).toHaveLength(1);
    // A run with no usable id must not be read as id 0 and beat a real id.
    const withReal = mergeCellRuns([a, run("5", JobStatus.Failure)]);
    expect(withReal.id).toBe("5");
    // Distinct keys, so React cannot collapse two rows into one.
    expect(new Set(forward.cellRuns!.map(runKeyOf)).size).toBe(2);
  });

  // Classification text is the largest thing a run can carry (55 KB on one run of a real page), and
  // torchci classifies plenty of runs that did not fail. Over the 50 newest pytorch/pytorch trunk
  // commits, runs on multi-run cells hold 1.35 MB of it and only 4.7 KB sits on a genuinely failed
  // run -- so carrying it unconditionally would add ~1.3 MB to the grid to explain nothing.
  test("classification is carried only for runs that actually failed", () => {
    const diagnostics = {
      failureLines: ["boom"],
      failureCaptures: ["boom"],
      failureLineNumbers: [7],
      name: "w / j",
    };
    const merged = mergeCellRuns([
      { id: "1", conclusion: JobStatus.Failure, ...diagnostics },
      // Cancelled and skipped runs routinely carry a classification line; it is not a failure.
      { id: "2", conclusion: JobStatus.Cancelled, ...diagnostics },
      { id: "3", conclusion: JobStatus.Skipped, ...diagnostics },
    ]);
    const byId = new Map(merged.cellRuns!.map((r) => [r.id, r]));
    expect(byId.get("1")!.failureLines).toEqual(["boom"]);
    expect(byId.get("2")!.failureLines).toBeUndefined();
    expect(byId.get("2")!.failureCaptures).toBeUndefined();
    expect(byId.get("3")!.failureLines).toBeUndefined();
    // Still named and still reachable -- only the bulky classification is withheld.
    expect(byId.get("2")!.conclusion).toBe(JobStatus.Cancelled);
    expect(byId.get("3")!.id).toBe("3");
  });

  test("a stale failedPreviousRun on an input row cannot leak into a clean cell", () => {
    const poisoned: JobData = {
      id: "1",
      conclusion: JobStatus.Success,
      failedPreviousRun: true,
      name: "w / j",
    };
    const merged = mergeCellRuns([poisoned, run("2", JobStatus.Success)]);
    expect(merged.failedPreviousRun).toBeUndefined();
    expect("failedPreviousRun" in merged).toBe(false);
  });

  // Selecting a run is not enough on its own: the diagnostics are per-run, and the cell holds the
  // representative's -- which on a flaky "F" cell is the run that PASSED.
  describe("detailJobForRun", () => {
    const failing: JobData = {
      id: "2",
      conclusion: JobStatus.Failure,
      logUrl: "https://example.com/failed-log",
      htmlUrl: "https://example.com/failed-run",
      failureLines: ["boom"],
      failureCaptures: ["boom"],
      name: "w / j",
    };
    const passing: JobData = {
      id: "1",
      conclusion: JobStatus.Success,
      logUrl: "https://example.com/passed-log",
      name: "w / j",
    };

    test("with no selection it is the cell itself", () => {
      const cell = mergeCellRuns([passing, failing]);
      expect(detailJobForRun(cell, undefined)).toBe(cell);
    });

    test("selecting the failure rebinds the log and the classification to it", () => {
      const cell = mergeCellRuns([passing, failing]);
      expect(cell.logUrl).toBe("https://example.com/passed-log");
      const failedRun = cell.cellRuns!.find(
        (r) => r.conclusion === JobStatus.Failure
      )!;
      const detail = detailJobForRun(cell, failedRun);
      expect(detail.logUrl).toBe("https://example.com/failed-log");
      expect(detail.conclusion).toBe(JobStatus.Failure);
      expect(detail.failureLines).toEqual(["boom"]);
      // Cell-level context the run does not carry is kept.
      expect(detail.name).toBe("w / j");
      // Not a marker for a consumer of JobData to trip over.
      expect("isRepresentative" in detail).toBe(false);
    });

    // The bug this pins is invisible in memory. mergeCellRuns builds each CellRun with explicit
    // `undefined` properties, so a spread-based implementation overrides correctly here -- but
    // JSON.stringify DROPS those keys, and the grid reaches the browser as JSON. Every assertion
    // below must therefore run against a round-tripped payload, which is the only shape that ships.
    test("a selected run keeps its own identity after a JSON round trip", () => {
      const cell = JSON.parse(
        JSON.stringify(
          mergeCellRuns([
            {
              id: "1",
              conclusion: JobStatus.Success,
              logUrl: "https://example.com/push-log",
              htmlUrl: "https://example.com/push-run",
              durationS: 11,
              name: "w / j",
            },
            {
              id: "2",
              conclusion: JobStatus.Failure,
              runOrigin: "autorevert",
              restartDispatchedBy: "pytorch-auto-revert[bot]",
              restartRunAttempt: 2,
              logUrl: "https://example.com/restart-log",
              htmlUrl: "https://example.com/restart-run",
              durationS: 22,
              name: "w / j",
            },
          ])
        )
      ) as JobData;

      // The cell is the push run (rule 2 gives a mixed cell to the success) and renders flaky.
      expect(cell.id).toBe("1");
      expect(cell.failedPreviousRun).toBe(true);

      const restart = cell.cellRuns!.find((r) => r.id === "2")!;
      const restartDetail = detailJobForRun(cell, restart);
      expect(restartDetail.logUrl).toBe("https://example.com/restart-log");
      expect(restartDetail.htmlUrl).toBe("https://example.com/restart-run");
      expect(restartDetail.durationS).toBe(22);
      expect(restartDetail.runOrigin).toBe("autorevert");
      // A single run is never itself "flaky" -- that is a property of the set.
      expect(restartDetail.failedPreviousRun).toBeUndefined();

      // And back the other way: the push run must not pick up the restart's identity just because
      // its own keys were dropped from the JSON for being undefined.
      const push = cell.cellRuns!.find((r) => r.id === "1")!;
      expect("runOrigin" in push).toBe(false);
      const pushDetail = detailJobForRun(cell, push);
      expect(pushDetail.logUrl).toBe("https://example.com/push-log");
      expect(pushDetail.runOrigin).toBeUndefined();
      expect(pushDetail.restartDispatchedBy).toBeUndefined();
      expect(pushDetail.restartRunAttempt).toBeUndefined();
    });

    test("selecting a run without diagnostics does not inherit another run's failure", () => {
      // The subtle one: a CellRun omits the keys it has no value for, so a naive spread would leave
      // the representative's captures in place and attribute one run's failure to another.
      //
      // Two failures, so the representative is the one that CARRIES lines (rule 2 would otherwise
      // hand the cell to a success, which has none and could not show the bug).
      const cell = mergeCellRuns([
        failing,
        { id: "1", conclusion: JobStatus.Failure, name: "w / j" },
      ]);
      expect(cell.id).toBe("2");
      expect(cell.failureLines).toEqual(["boom"]);
      const otherFailure = cell.cellRuns!.find((r) => r.id === "1")!;
      const detail = detailJobForRun(cell, otherFailure);
      expect(detail.failureLines).toBeUndefined();
      expect(detail.failureCaptures).toBeUndefined();
      expect(detail.logUrl).toBeUndefined();
    });
  });

  test("an empty cell merges to an empty job rather than throwing", () => {
    expect(mergeCellRuns([])).toEqual({});
  });
});
