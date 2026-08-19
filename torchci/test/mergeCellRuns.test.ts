import { JobStatus } from "components/job/GroupJobConclusion";
import { getConclusionChar } from "lib/JobClassifierUtil";
import {
  describeCellRun,
  describeRunIdentity,
  describeRunOrigin,
  detailJobForRun,
  disambiguateCellRuns,
  mergeCellRuns,
  runKeyOf,
} from "lib/mergeCellRuns";
import { CellRun, JobData } from "lib/types";
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

  // The ODC command reads (workflowId, id, failureLineNumbers) as ONE run's identity, so a run list
  // that carried only `id` produced a command pairing the selected run's job with the
  // representative's workflow -- a pair that never existed.
  test("each run carries its own workflow id, and an annotation only when it has one", () => {
    const merged = mergeCellRuns([
      {
        id: "1",
        workflowId: "100",
        conclusion: JobStatus.Failure,
        failureAnnotation: "infra flake",
        name: "w / j",
      },
      {
        id: "2",
        workflowId: "200",
        conclusion: JobStatus.Failure,
        name: "w / j",
      },
    ]);
    const byId = new Map(merged.cellRuns!.map((r) => [r.id, r]));
    expect(byId.get("1")!.workflowId).toBe("100");
    expect(byId.get("2")!.workflowId).toBe("200");
    expect(byId.get("1")!.failureAnnotation).toBe("infra flake");
    // Absent rather than empty: an unannotated job carries '' on some producers, and fetchHud strips
    // only nulls -- so assigning it would ship a key saying nothing on every run of every cell.
    expect("failureAnnotation" in byId.get("2")!).toBe(false);
  });

  // The run list shows one short line per row, so the dispatch identity is rendered once for the run
  // being inspected instead of on every row. A run with nothing to report must yield '', not a stray
  // empty line under the list.
  test("run identity names attempt, dispatcher and rerunner, and is empty when there are none", () => {
    expect(
      describeRunIdentity({
        runOrigin: "autorevert",
        restartRunAttempt: 2,
        restartDispatchedBy: "pytorch-auto-revert[bot]",
        restartRerunBy: "someone",
      })
    ).toBe(
      "attempt 2, dispatched by pytorch-auto-revert[bot], rerun by someone"
    );
    expect(
      describeRunIdentity({
        runOrigin: "autorevert",
        restartDispatchedBy: "pytorch-auto-revert[bot]",
      })
    ).toBe("dispatched by pytorch-auto-revert[bot]");
    expect(describeRunIdentity({ conclusion: JobStatus.Success })).toBe("");
    // Attempt 1 is still worth naming: it distinguishes a restart from its own re-runs.
    expect(describeRunIdentity({ restartRunAttempt: 1 })).toBe("attempt 1");
  });

  // Two runs sharing an origin AND a conclusion produced byte-identical row text, hover text and
  // accessible name, because the restart fields that would separate them are absent on every ordinary
  // push or periodic run. The suffix is added only to the rows that would collide.
  describe("disambiguateCellRuns", () => {
    test("runs that already read differently get no suffix", () => {
      const push: CellRun = {
        id: "1",
        workflowId: "10",
        conclusion: "success",
      };
      const periodic: CellRun = {
        id: "2",
        workflowId: "20",
        conclusion: "success",
        runOrigin: "schedule",
      };
      const suffixes = disambiguateCellRuns([push, periodic]);
      expect(suffixes.get(push)).toBe("");
      expect(suffixes.get(periodic)).toBe("");
    });

    // Note the scope of the title: conclusions that map to DIFFERENT glyphs are a difference. Two
    // conclusions that both fall through to `U` are not, which is the `action_required` / `stale` case
    // further down.
    test("conclusions that draw different glyphs are already a difference, so neither row is suffixed", () => {
      const passed: CellRun = {
        id: "1",
        workflowId: "10",
        conclusion: "success",
      };
      const failed: CellRun = {
        id: "2",
        workflowId: "20",
        conclusion: "failure",
      };
      const suffixes = disambiguateCellRuns([passed, failed]);
      expect(suffixes.get(passed)).toBe("");
      expect(suffixes.get(failed)).toBe("");
    });

    // The REQUIREMENT is that the rendered strings end up unique, not that any particular field was
    // chosen -- asserting the field would pin the implementation's own guess and could pass while two
    // rows still read the same (a suffix built from a shared value separates nothing).
    //
    // `visible` includes the GLYPH CHARACTER, because that is on the row: a model that dropped it would
    // report two `U`-drawing runs as already distinct and could not see the defect this covers.
    function rowStrings(runs: CellRun[]): {
      visible: string[];
      accessible: string[];
    } {
      const suffixes = disambiguateCellRuns(runs);
      return {
        visible: runs.map(
          (run) =>
            `${getConclusionChar(run.conclusion)} ${describeRunOrigin(
              run
            )}${suffixes.get(run)}`
        ),
        accessible: runs.map(
          (run) => `${describeCellRun(run)}${suffixes.get(run)}`
        ),
      };
    }

    function allDistinct(values: string[]): boolean {
      return new Set(values).size === values.length;
    }

    test("colliding runs end up with distinct row text, hover text and accessible name", () => {
      const first: CellRun = {
        id: "1",
        workflowId: "10",
        conclusion: "success",
        runOrigin: "schedule",
      };
      const second: CellRun = {
        id: "2",
        workflowId: "20",
        conclusion: "success",
        runOrigin: "schedule",
      };
      // Without a suffix these are the same string, which is the defect.
      expect(describeRunOrigin(first)).toBe(describeRunOrigin(second));
      expect(describeCellRun(first)).toBe(describeCellRun(second));
      const rows = rowStrings([first, second]);
      expect(allDistinct(rows.visible)).toBe(true);
      expect(allDistinct(rows.accessible)).toBe(true);
    });

    // `workflowId` is `job.run_id`, which every re-run ATTEMPT of one run shares. A disambiguator
    // picked by presence rather than by distinctness would hand both rows the same suffix and
    // separate nothing (DP17, gpt-5.6-sol).
    test("two retries of ONE run share a workflow id and are still told apart", () => {
      const attemptTwo: CellRun = {
        id: "11",
        workflowId: "500",
        conclusion: "failure",
        runOrigin: "retry",
      };
      const attemptThree: CellRun = {
        id: "12",
        workflowId: "500",
        conclusion: "failure",
        runOrigin: "retry",
      };
      const suffixes = disambiguateCellRuns([attemptTwo, attemptThree]);
      expect(suffixes.get(attemptTwo)).not.toBe(suffixes.get(attemptThree));
      const rows = rowStrings([attemptTwo, attemptThree]);
      expect(allDistinct(rows.visible)).toBe(true);
    });

    // The row shows the ORIGIN and a glyph, not the attempt -- so two restarts of one cell read the
    // same on screen even though `describeCellRun` separates them (DP17, gpt-5.6-sol).
    test("two restarts differing only by attempt read the same on the row, so they are suffixed", () => {
      const attemptOne: CellRun = {
        id: "1",
        workflowId: "10",
        conclusion: "failure",
        runOrigin: "autorevert",
        restartRunAttempt: 1,
      };
      const attemptTwo: CellRun = {
        id: "2",
        workflowId: "20",
        conclusion: "failure",
        runOrigin: "autorevert",
        restartRunAttempt: 2,
      };
      // `describeCellRun` already differs here; the VISIBLE line does not.
      expect(describeCellRun(attemptOne)).not.toBe(describeCellRun(attemptTwo));
      expect(describeRunOrigin(attemptOne)).toBe(describeRunOrigin(attemptTwo));
      const rows = rowStrings([attemptOne, attemptTwo]);
      expect(allDistinct(rows.visible)).toBe(true);
    });

    test("only the colliding group is suffixed, and a distinct row is left alone", () => {
      const a: CellRun = { id: "1", workflowId: "10", conclusion: "success" };
      const b: CellRun = { id: "2", workflowId: "20", conclusion: "success" };
      const restart: CellRun = {
        id: "3",
        workflowId: "30",
        conclusion: "success",
        runOrigin: "autorevert",
        restartRunAttempt: 1,
      };
      const suffixes = disambiguateCellRuns([a, b, restart]);
      expect(suffixes.get(a)).not.toBe("");
      expect(suffixes.get(b)).not.toBe("");
      expect(suffixes.get(a)).not.toBe(suffixes.get(b));
      // Its origin already differs, so it keeps the one short line.
      expect(suffixes.get(restart)).toBe("");
    });

    // `getConclusionChar` folds every conclusion outside the known set onto `U`, so two runs can draw
    // the identical glyph while their conclusion strings differ -- which a signature built from the
    // conclusion rather than the glyph reports as "already different" (DP17, gpt-5.6-sol).
    test("two unknown conclusions draw the same glyph, so those rows are suffixed", () => {
      const actionRequired: CellRun = {
        id: "1",
        workflowId: "10",
        conclusion: "action_required",
      };
      const stale: CellRun = { id: "2", workflowId: "20", conclusion: "stale" };
      expect(getConclusionChar(actionRequired.conclusion)).toBe(
        getConclusionChar(stale.conclusion)
      );
      // Their descriptions DO differ, so nothing but the glyph reveals the collision.
      expect(describeCellRun(actionRequired)).not.toBe(describeCellRun(stale));
      // The requirement is that the RENDERED rows differ, not that both carry a suffix.
      expect(allDistinct(rowStrings([actionRequired, stale]).visible)).toBe(
        true
      );
    });

    // The mirror of the case above, and the reason the glyph signature is not the only one consulted:
    // `conclusionOf` folds both an ABSENT and an EMPTY conclusion onto `pending`, while the glyph draws
    // `~` for absent and `U` for empty. So these two rows look different on screen but their hover text
    // and accessible name are the same string -- which a screen reader is all that renders.
    test("rows that differ only by glyph still share a description, and are suffixed for it", () => {
      const absent: CellRun = { id: "1", workflowId: "10" };
      const empty: CellRun = { id: "2", workflowId: "20", conclusion: "" };
      expect(getConclusionChar(absent.conclusion)).not.toBe(
        getConclusionChar(empty.conclusion)
      );
      expect(describeCellRun(absent)).toBe(describeCellRun(empty));
      // The ACCESSIBLE name is the one at risk here, so that is what has to come out distinct.
      expect(allDistinct(rowStrings([absent, empty]).accessible)).toBe(true);
    });

    test("two runs whose glyphs differ are left alone", () => {
      const failed: CellRun = {
        id: "1",
        workflowId: "10",
        conclusion: "failure",
      };
      const timedOut: CellRun = {
        id: "2",
        workflowId: "20",
        conclusion: "timed_out",
      };
      expect(getConclusionChar(failed.conclusion)).not.toBe(
        getConclusionChar(timedOut.conclusion)
      );
      const suffixes = disambiguateCellRuns([failed, timedOut]);
      expect(suffixes.get(failed)).toBe("");
      expect(suffixes.get(timedOut)).toBe("");
    });

    test("a group with no job id falls back to the workflow id when that separates it", () => {
      const first: CellRun = { workflowId: "10", conclusion: "success" };
      const second: CellRun = { workflowId: "20", conclusion: "success" };
      const suffixes = disambiguateCellRuns([first, second]);
      expect(suffixes.get(first)).toBe(" (run 10)");
      expect(suffixes.get(second)).toBe(" (run 20)");
    });

    // A candidate only ONE row of the group has still separates the group: the other row's suffix is
    // '', and '' differs from a suffix. Testing that the values are all PRESENT would reject this and
    // leave two identical rows on screen (DP17, gpt-5.6-sol).
    test("a candidate only one row carries still separates the pair", () => {
      const withJobId: CellRun = { id: "7", conclusion: "success" };
      const bare: CellRun = { conclusion: "success" };
      const suffixes = disambiguateCellRuns([withJobId, bare]);
      expect(suffixes.get(withJobId)).toBe(" (job 7)");
      expect(suffixes.get(bare)).toBe("");
      expect(allDistinct(rowStrings([withJobId, bare]).visible)).toBe(true);
    });

    test("a group nothing can separate is left bare rather than given a made-up ordinal", () => {
      // Neither row carries either identifier, so no candidate produces two different suffixes.
      // Silence is the honest answer -- an ordinal would re-point at a different run on the next
      // refresh, since the list is rebuilt and re-ordered from fresh data.
      const twin: CellRun = { conclusion: "success" };
      const other: CellRun = { conclusion: "success" };
      const suffixes = disambiguateCellRuns([twin, other]);
      expect(suffixes.get(twin)).toBe("");
      expect(suffixes.get(other)).toBe("");
      // And that is consistent with the rest of the module: these two rows are ONE run as far as
      // selection is concerned, since `runKeyOf` gives them the same key.
      expect(runKeyOf(twin)).toBe(runKeyOf(other));
    });

    test("an empty list is not a special case", () => {
      expect(disambiguateCellRuns([]).size).toBe(0);
    });
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

    test("selecting a run rebinds its workflow id and annotation, and clears one it lacks", () => {
      // Round-tripped, for the same reason as the test above: the un-annotated run's key is dropped
      // by JSON.stringify, which is exactly when an implementation that relied on the key being
      // present would leave the representative's annotation standing.
      const cell = JSON.parse(
        JSON.stringify(
          mergeCellRuns([
            {
              id: "2",
              workflowId: "200",
              conclusion: JobStatus.Failure,
              failureAnnotation: "infra flake",
              failureLines: ["boom"],
              name: "w / j",
            },
            {
              id: "1",
              workflowId: "100",
              conclusion: JobStatus.Failure,
              name: "w / j",
            },
          ])
        )
      ) as JobData;

      expect(cell.id).toBe("2");
      expect(cell.failureAnnotation).toBe("infra flake");

      const other = cell.cellRuns!.find((r) => r.id === "1")!;
      const detail = detailJobForRun(cell, other);
      expect(detail.workflowId).toBe("100");
      expect(detail.failureAnnotation).toBeUndefined();
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
