import {
  DEFAULT_MAX_DISPATCH_PER_PR,
  DEFAULT_MAX_NEW_FAILURES,
} from "lib/advisor/advisorConfig";
import {
  autoDispatchAdvisorForNewFailures,
  AutoDispatchDeps,
  MAX_DISPATCH_RETRIES,
  signalKeyForJob,
  stableHashSelect,
} from "lib/advisor/advisorDispatch";
import { RecentWorkflowsData } from "lib/types";

const VALID_SHA = "a".repeat(40);

function job(
  name: string,
  conclusion = "failure",
  failure_captures: string[] = []
): RecentWorkflowsData {
  return {
    name,
    conclusion,
    failure_captures,
  } as unknown as RecentWorkflowsData;
}

function makeDeps(overrides: Partial<AutoDispatchDeps> = {}): AutoDispatchDeps {
  return {
    readDispatchStates: jest.fn().mockResolvedValue(new Map()),
    countHeadDispatches: jest.fn().mockResolvedValue(0),
    recordDispatch: jest.fn().mockResolvedValue(undefined),
    dispatchAdvisorWorkflow: jest.fn().mockResolvedValue(undefined),
    getPullRequestMeta: jest
      .fn()
      .mockResolvedValue({ state: "open", draft: false, labels: [] }),
    ...overrides,
  };
}

const baseArgs = {
  owner: "pytorch",
  repo: "pytorch",
  prNumber: 123,
  headSha: VALID_SHA,
  mergeBaseSha: "b".repeat(40),
};

describe("autoDispatchAdvisorForNewFailures", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.DRCI_ADVISOR_AUTODISPATCH_ENABLED = "true";
    process.env.VERCEL_ENV = "production";
  });

  afterEach(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
  });

  it("no-ops when the feature flag is off", async () => {
    process.env.DRCI_ADVISOR_AUTODISPATCH_ENABLED = "false";
    const deps = makeDeps();
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a")] },
      deps
    );
    expect(deps.readDispatchStates).not.toHaveBeenCalled();
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
  });

  it("no-ops when not in production", async () => {
    process.env.VERCEL_ENV = "preview";
    const deps = makeDeps();
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a")] },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
  });

  it("no-ops for a repo without advisor config", async () => {
    const deps = makeDeps();
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, repo: "vision", newFailures: [job("wf / a")] },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
  });

  it("dispatches each new failure with pre/post writes", async () => {
    const deps = makeDeps();
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a"), job("wf / b")] },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).toHaveBeenCalledTimes(2);
    // 2 jobs x (dispatching + dispatched)
    expect(deps.recordDispatch).toHaveBeenCalledTimes(4);
    const states = (deps.recordDispatch as jest.Mock).mock.calls.map(
      (c) => c[0].state
    );
    expect(states).toEqual([
      "dispatching",
      "dispatched",
      "dispatching",
      "dispatched",
    ]);
    expect(deps.dispatchAdvisorWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: "wf / a", workflowName: "wf" })
    );
  });

  it("excludes cancelled jobs", async () => {
    const deps = makeDeps();
    await autoDispatchAdvisorForNewFailures(
      {
        ...baseArgs,
        newFailures: [job("wf / a", "cancelled"), job("wf / b")],
      },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).toHaveBeenCalledTimes(1);
    expect(deps.dispatchAdvisorWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: "wf / b" })
    );
  });

  it("skips jobs already dispatching or dispatched", async () => {
    const states = new Map([
      [
        signalKeyForJob("wf / a"),
        { state: "dispatched" as const, retryCount: 0 },
      ],
      [
        signalKeyForJob("wf / b"),
        { state: "dispatching" as const, retryCount: 0 },
      ],
    ]);
    const deps = makeDeps({
      readDispatchStates: jest.fn().mockResolvedValue(states),
    });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a"), job("wf / b")] },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
  });

  it("does not retry a failed job that is out of retries", async () => {
    const states = new Map([
      [
        signalKeyForJob("wf / a"),
        { state: "failed" as const, retryCount: MAX_DISPATCH_RETRIES },
      ],
    ]);
    const deps = makeDeps({
      readDispatchStates: jest.fn().mockResolvedValue(states),
    });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a")] },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
  });

  it("retries a failed job under the retry limit and increments retry_count", async () => {
    const states = new Map([
      [signalKeyForJob("wf / a"), { state: "failed" as const, retryCount: 1 }],
    ]);
    const deps = makeDeps({
      readDispatchStates: jest.fn().mockResolvedValue(states),
    });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a")] },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).toHaveBeenCalledTimes(1);
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ state: "dispatching", retryCount: 2 })
    );
  });

  it("fails closed when the dedup read throws (dispatches nothing)", async () => {
    const deps = makeDeps({
      readDispatchStates: jest.fn().mockRejectedValue(new Error("CH down")),
    });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a")] },
      deps
    );
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
  });

  it("aborts the PR when the pre-dispatch write throws", async () => {
    const deps = makeDeps({
      recordDispatch: jest.fn().mockRejectedValue(new Error("write down")),
    });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a"), job("wf / b")] },
      deps
    );
    // Pre-write attempted once, then aborts before dispatching anything.
    expect(deps.recordDispatch).toHaveBeenCalledTimes(1);
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
  });

  it("records a failed state when the dispatch throws", async () => {
    const deps = makeDeps({
      dispatchAdvisorWorkflow: jest.fn().mockRejectedValue(new Error("gh 500")),
    });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a")] },
      deps
    );
    const states = (deps.recordDispatch as jest.Mock).mock.calls.map(
      (c) => c[0].state
    );
    expect(states).toEqual(["dispatching", "failed"]);
  });

  it("bails entirely when new failures exceed the per-repo max (no bypass label)", async () => {
    const failures = Array.from(
      { length: DEFAULT_MAX_NEW_FAILURES + 1 },
      (_, i) => job(`wf / job-${i}`)
    );
    const deps = makeDeps();
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: failures },
      deps
    );
    // Dedup + PR state are read (labels are needed to decide the bypass), but
    // the outage guard then bails without dispatching anything.
    expect(deps.readDispatchStates).toHaveBeenCalled();
    expect(deps.getPullRequestMeta).toHaveBeenCalled();
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
  });

  it("does not bail on a ci-no-td PR over the max; caps to maxDispatchPerPr by stable hash", async () => {
    const failures = Array.from(
      { length: DEFAULT_MAX_DISPATCH_PER_PR + 10 },
      (_, i) => job(`wf / job-${i}`)
    );
    const deps = makeDeps({
      getPullRequestMeta: jest.fn().mockResolvedValue({
        state: "open",
        draft: false,
        labels: ["ci-no-td"],
      }),
    });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: failures },
      deps
    );
    // Capped at the sanity ceiling rather than bailed or fanned out in full.
    expect(deps.dispatchAdvisorWorkflow).toHaveBeenCalledTimes(
      DEFAULT_MAX_DISPATCH_PER_PR
    );
  });

  it("caps cumulatively per head: prior dispatches reduce the budget even if they no longer fail", async () => {
    // 30 signals already recorded for this head (now passing, so NOT in the
    // current failure set), 10 brand-new fresh failures, ci-no-td, cap 32 ->
    // only 2 new dispatched. The head count (not the current-failure dedup map)
    // is what bounds the cumulative cap.
    const failures = Array.from({ length: 10 }, (_, i) =>
      job(`wf / fresh-${i}`)
    );
    const deps = makeDeps({
      countHeadDispatches: jest.fn().mockResolvedValue(30),
      getPullRequestMeta: jest.fn().mockResolvedValue({
        state: "open",
        draft: false,
        labels: ["ci-no-td"],
      }),
    });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: failures },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).toHaveBeenCalledTimes(
      DEFAULT_MAX_DISPATCH_PER_PR - 30
    );
  });

  it("dispatches nothing new once the per-head cap is already reached", async () => {
    const failures = Array.from({ length: 5 }, (_, i) =>
      job(`wf / fresh-${i}`)
    );
    const deps = makeDeps({
      countHeadDispatches: jest
        .fn()
        .mockResolvedValue(DEFAULT_MAX_DISPATCH_PER_PR),
      getPullRequestMeta: jest.fn().mockResolvedValue({
        state: "open",
        draft: false,
        labels: ["ci-no-td"],
      }),
    });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: failures },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
  });

  it("fails closed when the head dispatch count throws", async () => {
    const deps = makeDeps({
      countHeadDispatches: jest.fn().mockRejectedValue(new Error("CH down")),
    });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a")] },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
    // The pre-dispatch marker is never written either.
    expect(deps.recordDispatch).not.toHaveBeenCalled();
  });

  it("dispatches all when new failures are exactly at the max", async () => {
    const failures = Array.from({ length: DEFAULT_MAX_NEW_FAILURES }, (_, i) =>
      job(`wf / job-${i}`)
    );
    const deps = makeDeps();
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: failures },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).toHaveBeenCalledTimes(
      DEFAULT_MAX_NEW_FAILURES
    );
  });

  it("does not dispatch on a closed PR", async () => {
    const deps = makeDeps({
      getPullRequestMeta: jest
        .fn()
        .mockResolvedValue({ state: "closed", draft: false, labels: [] }),
    });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a")] },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
    // Skipped after dedup but before any marker write.
    expect(deps.recordDispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch on a draft PR", async () => {
    const deps = makeDeps({
      getPullRequestMeta: jest
        .fn()
        .mockResolvedValue({ state: "open", draft: true, labels: [] }),
    });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a")] },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
  });

  it("does not look up PR state when every failure is already deduped", async () => {
    const states = new Map([
      [
        signalKeyForJob("wf / a"),
        { state: "dispatched" as const, retryCount: 0 },
      ],
    ]);
    const deps = makeDeps({
      readDispatchStates: jest.fn().mockResolvedValue(states),
    });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a")] },
      deps
    );
    expect(deps.getPullRequestMeta).not.toHaveBeenCalled();
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
  });
});

describe("stableHashSelect", () => {
  const keys = Array.from({ length: 20 }, (_, i) => `key-${i}`);

  it("returns all keys when n >= length, and [] when n <= 0", () => {
    expect(stableHashSelect(keys, "sha", keys.length)).toEqual(keys);
    expect(stableHashSelect(keys, "sha", keys.length + 5)).toEqual(keys);
    expect(stableHashSelect(keys, "sha", 0)).toEqual([]);
    expect(stableHashSelect(keys, "sha", -1)).toEqual([]);
  });

  it("is deterministic for a given salt", () => {
    expect(stableHashSelect(keys, "sha", 5)).toEqual(
      stableHashSelect(keys, "sha", 5)
    );
  });

  it("a smaller pick is a subset of a larger pick from the same set", () => {
    // The lowest-hash 5 are always within the lowest-hash 8 of the same set, so
    // raising the budget only adds jobs -- it never reshuffles existing picks.
    const five = stableHashSelect(keys, "sha", 5);
    const eight = stableHashSelect(keys, "sha", 8);
    expect(five.every((k) => eight.includes(k))).toBe(true);
  });

  it("varies the selection by salt (head sha)", () => {
    const a = stableHashSelect(keys, "shaA", 5);
    const b = stableHashSelect(keys, "shaB", 5);
    expect(a).not.toEqual(b);
  });

  it("never returns more than n", () => {
    expect(stableHashSelect(keys, "sha", 7)).toHaveLength(7);
  });
});
