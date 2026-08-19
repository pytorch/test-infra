import { getWorkflowIdsByName } from "lib/fetchCommit";
import { describeRunOrigin, describeWorkflowRun } from "lib/runOrigin";
import { JobData } from "lib/types";

describe("describeRunOrigin", () => {
  test("names the origins the HUD tooltip and the commit page share", () => {
    expect(describeRunOrigin({ runOrigin: "autorevert" })).toEqual(
      "autorevert restart"
    );
    expect(describeRunOrigin({ runOrigin: "retry" })).toEqual("re-run attempt");
    expect(describeRunOrigin({ runOrigin: "schedule" })).toEqual("schedule");
  });

  test("a missing origin means push, whether it arrives absent or as SQL NULL", () => {
    // hud_query strips the key; commit_jobs_query ships a real NULL. Both mean the same run.
    expect(describeRunOrigin({})).toEqual("push");
    expect(describeRunOrigin({ runOrigin: null })).toEqual("push");
  });

  test("a blank origin is not reported as push, because that would be a guess", () => {
    expect(describeRunOrigin({ runOrigin: "" })).toEqual("unknown");
    expect(describeRunOrigin({ runOrigin: "   " })).toEqual("unknown");
  });
});

describe("describeWorkflowRun", () => {
  test("an autorevert restart names both what it is and who dispatched it", () => {
    expect(
      describeWorkflowRun({
        runOrigin: "autorevert",
        restartDispatchedBy: "pytorch-auto-revert[bot]",
      })
    ).toEqual("autorevert restart by pytorch-auto-revert[bot]");
  });

  test("a restart with no recorded dispatcher still says what it is", () => {
    expect(describeWorkflowRun({ runOrigin: "autorevert" })).toEqual(
      "autorevert restart"
    );
  });

  test("every run is named, including a plain push", () => {
    // Deliberate: an unlabelled row in a picker that exists to disambiguate cannot be told apart
    // from one whose data is missing.
    expect(describeWorkflowRun({})).toEqual("push");
    expect(
      describeWorkflowRun({ runOrigin: null, restartDispatchedBy: null })
    ).toEqual("push");
  });

  // The two entries in the reviewer's screenshot differed only by id. This is that case.
  test("a restart and a push in one picker do not read the same", () => {
    const push = describeWorkflowRun({ runOrigin: null });
    const restart = describeWorkflowRun({
      runOrigin: "autorevert",
      restartDispatchedBy: "pytorch-auto-revert[bot]",
    });
    expect(restart).not.toEqual(push);
  });
});

describe("getWorkflowIdsByName", () => {
  function job(overrides: Partial<JobData>): JobData {
    return {
      workflowName: "trunk",
      workflowId: "1",
      runAttempt: 1,
      ...overrides,
    } as JobData;
  }

  test("carries the origin and dispatcher through to the picker entries", () => {
    // Without this the formatter tests above would all still pass while the dropdown showed
    // nothing but bare ids.
    const byName = getWorkflowIdsByName([
      // NULL, not undefined: that is the shape commit_jobs_query actually ships for a push.
      job({
        workflowId: "100",
        runAttempt: 1,
        runOrigin: null,
        restartDispatchedBy: null,
      }),
      job({
        workflowId: "200",
        runAttempt: 1,
        runOrigin: "autorevert",
        restartDispatchedBy: "pytorch-auto-revert[bot]",
      }),
    ]);

    expect(byName["trunk"]).toEqual([
      {
        id: "100",
        attempt: 1,
        runOrigin: null,
        restartDispatchedBy: null,
      },
      {
        id: "200",
        attempt: 1,
        runOrigin: "autorevert",
        restartDispatchedBy: "pytorch-auto-revert[bot]",
      },
    ]);
    expect(byName["trunk"].map(describeWorkflowRun)).toEqual([
      "push",
      "autorevert restart by pytorch-auto-revert[bot]",
    ]);
  });

  test("dedup is still by (id, attempt), so two attempts stay separate entries", () => {
    const byName = getWorkflowIdsByName([
      job({ workflowId: "100", runAttempt: 1 }),
      job({ workflowId: "100", runAttempt: 1 }),
      job({ workflowId: "100", runAttempt: 2, runOrigin: "retry" }),
    ]);

    expect(byName["trunk"].map((run) => run.attempt)).toEqual([1, 2]);
    expect(byName["trunk"].map(describeWorkflowRun)).toEqual([
      "push",
      "re-run attempt",
    ]);
  });
});
