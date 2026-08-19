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
  test("an autorevert run is named by its origin, with no actor to repeat it", () => {
    // "autorevert restart by pytorch-auto-revert[bot]" said autorevert twice (Ivan, 2026-08-19).
    expect(describeWorkflowRun({ runOrigin: "autorevert" })).toEqual(
      "autorevert dispatch"
    );
  });

  test("the label depends only on the origin, never on who pressed the button", () => {
    // Why the actor is not named: commit_jobs_query classifies a trunk/<sha> workflow_dispatch as
    // "autorevert" regardless of WHO dispatched it, so the origin survives a human hand-dispatching
    // one while an actor-only label ("dispatched by <person>") would hide it. That classification
    // lives in SQL and is not exercised here; this only pins that the formatter reads the origin
    // and nothing else, which is what makes the SQL's answer the one the reader sees.
    expect(describeWorkflowRun({ runOrigin: "autorevert" })).toEqual(
      "autorevert dispatch"
    );
    // A non-trunk dispatch is a different origin and keeps the raw event name. Not ideal copy;
    // pre-existing on both surfaces via describeRunOrigin, and deliberately not changed here.
    expect(describeWorkflowRun({ runOrigin: "workflow_dispatch" })).toEqual(
      "workflow_dispatch"
    );
  });

  test("every run is named, including a plain push", () => {
    // Deliberate: an unlabelled row in a picker that exists to disambiguate cannot be told apart
    // from one whose data is missing.
    expect(describeWorkflowRun({})).toEqual("push");
    expect(describeWorkflowRun({ runOrigin: null })).toEqual("push");
  });

  test("other origins keep the wording they have in the HUD tooltip", () => {
    expect(describeWorkflowRun({ runOrigin: "retry" })).toEqual(
      "re-run attempt"
    );
    expect(describeWorkflowRun({ runOrigin: "schedule" })).toEqual("schedule");
  });

  // The two entries in the reviewer's screenshot differed only by id. This is that case.
  test("a restart and a push in one picker do not read the same", () => {
    expect(describeWorkflowRun({ runOrigin: "autorevert" })).not.toEqual(
      describeWorkflowRun({ runOrigin: null })
    );
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

  test("carries the origin through to the picker entries", () => {
    // Without this the formatter tests above would all still pass while the dropdown showed
    // nothing but bare ids.
    const byName = getWorkflowIdsByName([
      // NULL, not undefined: that is the shape commit_jobs_query actually ships for a push.
      job({ workflowId: "100", runAttempt: 1, runOrigin: null }),
      job({ workflowId: "200", runAttempt: 1, runOrigin: "autorevert" }),
    ]);

    expect(byName["trunk"]).toEqual([
      { id: "100", attempt: 1, runOrigin: null },
      { id: "200", attempt: 1, runOrigin: "autorevert" },
    ]);
    expect(byName["trunk"].map(describeWorkflowRun)).toEqual([
      "push",
      "autorevert dispatch",
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
