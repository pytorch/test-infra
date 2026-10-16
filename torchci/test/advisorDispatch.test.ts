import {
  DEFAULT_MAX_DISPATCH_PER_PR,
  DEFAULT_MAX_NEW_FAILURES,
} from "lib/advisor/advisorConfig";
import {
  autoDispatchAdvisorForNewFailures,
  AutoDispatchDeps,
  MAX_DISPATCH_RETRIES,
  ranAfterDispatch,
  readyToReanalyze,
  signalKeyForJob,
  stableHashSelect,
  toDispatchMark,
} from "lib/advisor/advisorDispatch";
import { AdvisorVerdictRow } from "lib/advisorVerdictUtils";
import { RecentWorkflowsData } from "lib/types";

const VALID_SHA = "a".repeat(40);

function job(
  name: string,
  conclusion = "failure",
  failure_captures: string[] = [],
  completed_at = ""
): RecentWorkflowsData {
  return {
    name,
    conclusion,
    failure_captures,
    completed_at,
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

  it("never dispatches on a PR-state gate", async () => {
    const deps = makeDeps();
    await autoDispatchAdvisorForNewFailures(
      {
        ...baseArgs,
        newFailures: [
          job("Check mergeability of ghstack PR / ghstack-mergeability-check"),
          job("Check mergeability of ghstack PR"),
          job("Lint / pr-sanity-checks"),
          job("Check Labels / Check labels"),
          job("wf / b"),
        ],
      },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).toHaveBeenCalledTimes(1);
    expect(deps.dispatchAdvisorWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: "wf / b" })
    );
  });

  // Code signals the advisor can judge, even though flakiness detection skips
  // them.
  it("still dispatches on lint, docs, BC-lint and build failures", async () => {
    const names = [
      "Lint / lintrunner-noclang-partial / lint",
      "docs-build / linux-docs / build-docs-python-false",
      "BC Lint / bc_linter",
      "pull / linux-jammy-py3.10-gcc11 / build",
    ];
    const deps = makeDeps();
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: names.map((n) => job(n)) },
      deps
    );
    const dispatched = (
      deps.dispatchAdvisorWorkflow as jest.Mock
    ).mock.calls.map((c) => c[0].jobName);
    expect(dispatched.sort()).toEqual([...names].sort());
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

describe("rerun re-dispatch", () => {
  const OLD_ENV = process.env;
  const DISPATCHED_AT = "2026-10-16 00:53:36.569";
  const RERUN_DONE = "2026-10-16 01:13:57";
  const FIRST_DONE = "2026-10-16 00:15:45";
  // The first analysis answered after it was dispatched.
  const ANSWERED = [
    {
      sha: VALID_SHA,
      signal_key: signalKeyForJob("wf / a"),
      verdict: "not_related",
      confidence: 0.95,
      timestamp: "2026-10-16 00:54:54.000",
    } as unknown as AdvisorVerdictRow,
  ];

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.DRCI_ADVISOR_AUTODISPATCH_ENABLED = "true";
    process.env.VERCEL_ENV = "production";
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  const dispatchedStates = (version: string) =>
    new Map([
      [
        signalKeyForJob("wf / a"),
        { state: "dispatched" as const, retryCount: 0, version },
      ],
    ]);

  it("re-dispatches a dispatched job whose run finished after the dispatch", async () => {
    const deps = makeDeps({
      readDispatchStates: jest
        .fn()
        .mockResolvedValue(dispatchedStates(DISPATCHED_AT)),
    });
    await autoDispatchAdvisorForNewFailures(
      {
        ...baseArgs,
        newFailures: [job("wf / a", "failure", [], RERUN_DONE)],
        verdictRows: ANSWERED,
      },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).toHaveBeenCalledTimes(1);
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ state: "dispatching", retryCount: 0 })
    );
  });

  it("waits for the previous analysis to answer before re-dispatching", async () => {
    const deps = makeDeps({
      readDispatchStates: jest
        .fn()
        .mockResolvedValue(dispatchedStates(DISPATCHED_AT)),
    });
    const unanswered = [
      { ...ANSWERED[0], timestamp: "2026-10-16 00:40:00.000" },
    ] as AdvisorVerdictRow[];
    for (const verdictRows of [undefined, [], unanswered]) {
      await autoDispatchAdvisorForNewFailures(
        {
          ...baseArgs,
          newFailures: [job("wf / a", "failure", [], RERUN_DONE)],
          verdictRows,
        },
        deps
      );
    }
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
  });

  it("does not re-dispatch for the run the dispatch already analyzed", async () => {
    const deps = makeDeps({
      readDispatchStates: jest
        .fn()
        .mockResolvedValue(dispatchedStates(DISPATCHED_AT)),
    });
    await autoDispatchAdvisorForNewFailures(
      {
        ...baseArgs,
        newFailures: [job("wf / a", "failure", [], FIRST_DONE)],
        verdictRows: ANSWERED,
      },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
  });

  it("does not re-dispatch a job with no usable completed_at", async () => {
    const deps = makeDeps({
      readDispatchStates: jest
        .fn()
        .mockResolvedValue(dispatchedStates(DISPATCHED_AT)),
    });
    await autoDispatchAdvisorForNewFailures(
      {
        ...baseArgs,
        newFailures: [job("wf / a", "failure", [], "")],
        verdictRows: ANSWERED,
      },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
  });

  it("leaves an in-flight dispatching row alone even after a rerun", async () => {
    const deps = makeDeps({
      readDispatchStates: jest.fn().mockResolvedValue(
        new Map([
          [
            signalKeyForJob("wf / a"),
            {
              state: "dispatching" as const,
              retryCount: 0,
              version: DISPATCHED_AT,
            },
          ],
        ])
      ),
    });
    await autoDispatchAdvisorForNewFailures(
      {
        ...baseArgs,
        newFailures: [job("wf / a", "failure", [], RERUN_DONE)],
        verdictRows: [
          { ...ANSWERED[0], timestamp: "2026-10-16 00:40:00.000" },
        ] as AdvisorVerdictRow[],
      },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).not.toHaveBeenCalled();
  });

  // The 'dispatched' confirmation write is allowed to fail.
  it("re-dispatches after an answered dispatching row", async () => {
    const deps = makeDeps({
      readDispatchStates: jest.fn().mockResolvedValue(
        new Map([
          [
            signalKeyForJob("wf / a"),
            {
              state: "dispatching" as const,
              retryCount: 0,
              version: DISPATCHED_AT,
            },
          ],
        ])
      ),
    });
    await autoDispatchAdvisorForNewFailures(
      {
        ...baseArgs,
        newFailures: [job("wf / a", "failure", [], RERUN_DONE)],
        verdictRows: ANSWERED,
      },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).toHaveBeenCalledTimes(1);
  });

  it("a rerun is not held back by an exhausted per-PR budget", async () => {
    // The rerun's slot was counted when the job was first dispatched.
    const states = new Map(
      Array.from({ length: DEFAULT_MAX_DISPATCH_PER_PR }, (_, i) => [
        signalKeyForJob(`wf / ${i === 0 ? "a" : `other${i}`}`),
        { state: "dispatched" as const, retryCount: 0, version: DISPATCHED_AT },
      ])
    );
    const deps = makeDeps({
      readDispatchStates: jest.fn().mockResolvedValue(states),
    });
    await autoDispatchAdvisorForNewFailures(
      {
        ...baseArgs,
        newFailures: [job("wf / a", "failure", [], RERUN_DONE)],
        verdictRows: ANSWERED,
      },
      deps
    );
    expect(deps.dispatchAdvisorWorkflow).toHaveBeenCalledTimes(1);
  });
});

describe("ranAfterDispatch / readyToReanalyze", () => {
  it("treats a tie as a rerun and an unknown time as not one", () => {
    const at = "2026-10-16 01:13:57.000";
    expect(ranAfterDispatch(job("x", "failure", [], at), at)).toBe(true);
    expect(ranAfterDispatch(job("x", "failure", [], ""), at)).toBe(false);
    expect(ranAfterDispatch(job("x", "failure", [], at), "")).toBe(false);
  });

  it("is ready only when a verdict is strictly newer than the dispatch", () => {
    const at = "2026-10-16 00:53:36.569";
    const v = (timestamp: string) =>
      ({ timestamp } as unknown as AdvisorVerdictRow);
    expect(readyToReanalyze([v("2026-10-16 00:54:54.000")], at)).toBe(true);
    expect(readyToReanalyze([v(at)], at)).toBe(false);
    expect(readyToReanalyze([v("2026-10-16 00:40:00.000")], at)).toBe(false);
    expect(readyToReanalyze([], at)).toBe(false);
  });
});

describe("dispatch row versions", () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.DRCI_ADVISOR_AUTODISPATCH_ENABLED = "true";
    process.env.VERCEL_ENV = "production";
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  // The terminal row must carry the pre-dispatch time, which readers take as
  // when the analysis captured its evidence.
  it("stamps terminal rows from the pre-dispatch row's version", async () => {
    const PRE = "2026-10-16 00:53:36.569";
    const recordDispatch = jest.fn().mockResolvedValue(PRE);
    const deps = makeDeps({ recordDispatch });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a")] },
      deps
    );
    expect(recordDispatch.mock.calls[0]).toEqual([
      expect.objectContaining({ state: "dispatching" }),
    ]);
    expect(recordDispatch.mock.calls[1]).toEqual([
      expect.objectContaining({ state: "dispatched" }),
      PRE,
    ]);
  });

  it("stamps a failed row from the pre-dispatch row's version too", async () => {
    const PRE = "2026-10-16 00:53:36.569";
    const recordDispatch = jest.fn().mockResolvedValue(PRE);
    const deps = makeDeps({
      recordDispatch,
      dispatchAdvisorWorkflow: jest.fn().mockRejectedValue(new Error("5xx")),
    });
    await autoDispatchAdvisorForNewFailures(
      { ...baseArgs, newFailures: [job("wf / a")] },
      deps
    );
    expect(recordDispatch.mock.calls[1]).toEqual([
      expect.objectContaining({ state: "failed" }),
      PRE,
    ]);
  });
});

describe("toDispatchMark", () => {
  const v = "2026-10-16 00:53:36.569";
  it("marks a failed row under the retry limit as retry-pending", () => {
    expect(
      toDispatchMark({ state: "failed", retryCount: 0, version: v })
        .retryPending
    ).toBe(true);
    expect(
      toDispatchMark({
        state: "failed",
        retryCount: MAX_DISPATCH_RETRIES,
        version: v,
      }).retryPending
    ).toBe(false);
    expect(
      toDispatchMark({ state: "dispatched", retryCount: 0, version: v })
        .retryPending
    ).toBe(false);
  });

  it("a rerun within the dispatch's second counts as a rerun", () => {
    expect(
      ranAfterDispatch(job("x", "failure", [], "2026-10-16 00:53:36"), v)
    ).toBe(true);
    expect(
      ranAfterDispatch(job("x", "failure", [], "2026-10-16 00:53:35"), v)
    ).toBe(false);
  });
});
