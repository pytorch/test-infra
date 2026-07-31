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

  it("budget is reduced by already-dispatched current failures (cap minus states.size)", async () => {
    // 30 current failures already dispatched + 10 fresh, ci-no-td, cap 32 ->
    // only 2 of the fresh get dispatched this pass.
    const states = new Map(
      Array.from({ length: 30 }, (_, i) => [
        signalKeyForJob(`wf / done-${i}`),
        { state: "dispatched" as const, retryCount: 0 },
      ])
    );
    const failures = [
      ...Array.from({ length: 30 }, (_, i) => job(`wf / done-${i}`)),
      ...Array.from({ length: 10 }, (_, i) => job(`wf / fresh-${i}`)),
    ];
    const deps = makeDeps({
      readDispatchStates: jest.fn().mockResolvedValue(states),
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

  it("dispatches nothing new once the snapshot budget is exhausted", async () => {
    // 32 current failures already dispatched + 5 fresh, ci-no-td -> budget 0.
    const states = new Map(
      Array.from({ length: DEFAULT_MAX_DISPATCH_PER_PR }, (_, i) => [
        signalKeyForJob(`wf / done-${i}`),
        { state: "dispatched" as const, retryCount: 0 },
      ])
    );
    const failures = [
      ...Array.from({ length: DEFAULT_MAX_DISPATCH_PER_PR }, (_, i) =>
        job(`wf / done-${i}`)
      ),
      ...Array.from({ length: 5 }, (_, i) => job(`wf / fresh-${i}`)),
    ];
    const deps = makeDeps({
      readDispatchStates: jest.fn().mockResolvedValue(states),
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

  it("budget counts ALL current-failure records (dispatching + exhausted failed), not just dispatched", async () => {
    // 1 dispatching + 1 exhausted-failed already recorded for current failures
    // -> both consume budget (states.size = 2). Neither re-dispatches (one is in
    // flight, the other is out of retries), and 31 fresh failures are eligible,
    // so only 32 - 2 = 30 of the fresh get dispatched this pass.
    const states = new Map<
      string,
      { state: "dispatching" | "failed"; retryCount: number }
    >([
      [
        signalKeyForJob("wf / inflight"),
        { state: "dispatching", retryCount: 0 },
      ],
      [
        signalKeyForJob("wf / dead"),
        { state: "failed", retryCount: MAX_DISPATCH_RETRIES },
      ],
    ]);
    const failures = [
      job("wf / inflight"),
      job("wf / dead"),
      ...Array.from({ length: 31 }, (_, i) => job(`wf / fresh-${i}`)),
    ];
    const deps = makeDeps({
      readDispatchStates: jest.fn().mockResolvedValue(states),
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
      DEFAULT_MAX_DISPATCH_PER_PR - 2
    );
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
    expect(stableHashSelect(keys, keys.length)).toEqual(keys);
    expect(stableHashSelect(keys, keys.length + 5)).toEqual(keys);
    expect(stableHashSelect(keys, 0)).toEqual([]);
    expect(stableHashSelect(keys, -1)).toEqual([]);
  });

  it("is deterministic (depends only on the keys, no PR/SHA salt)", () => {
    expect(stableHashSelect(keys, 5)).toEqual(stableHashSelect(keys, 5));
  });

  it("selects by hash, not input order: shuffling the keys yields the same set", () => {
    // A naive `keys.slice(0, n)` would pass the determinism/subset/length tests
    // above but FAIL here -- reversing the input changes its first n. The real
    // hash selection is order-independent.
    const reversed = [...keys].reverse();
    expect(new Set(stableHashSelect(reversed, 5))).toEqual(
      new Set(stableHashSelect(keys, 5))
    );
    // And the chosen set is in fact not the leading slice (sanity check that the
    // hash actually reorders this key set).
    expect(new Set(stableHashSelect(keys, 5))).not.toEqual(
      new Set(keys.slice(0, 5))
    );
  });

  it("a smaller pick is a subset of a larger pick from the same set", () => {
    // The lowest-hash 5 are always within the lowest-hash 8 of the same set, so
    // raising the budget only adds jobs -- it never reshuffles existing picks.
    const five = stableHashSelect(keys, 5);
    const eight = stableHashSelect(keys, 8);
    expect(five.every((k) => eight.includes(k))).toBe(true);
  });

  it("never returns more than n", () => {
    expect(stableHashSelect(keys, 7)).toHaveLength(7);
  });
});
