import {
  ADVISOR_PENDING_ALT_ATTR,
  drciSignalKeyForJob,
  selectAdvisorLines,
  verdictCoversRun,
} from "lib/advisor/advisorBadge";
import {
  autoDispatchAdvisorForNewFailures,
  AutoDispatchDeps,
  dispatchAdvisorWorkflow,
  DispatchStateRow,
  ranAfterDispatch,
  toDispatchMark,
} from "lib/advisor/advisorDispatch";
import { AdvisorVerdictRow } from "lib/advisorVerdictUtils";
import * as clickhouse from "lib/clickhouse";
import * as github from "lib/github";
import { RecentWorkflowsData } from "lib/types";

jest.mock("lib/clickhouse", () => ({
  queryClickhouseSaved: jest.fn(),
  getClickhouseClientWritable: jest.fn(),
}));
jest.mock("lib/github", () => ({
  getOctokit: jest.fn(),
}));

const mockQuery = clickhouse.queryClickhouseSaved as jest.Mock;
const mockGetOctokit = github.getOctokit as jest.Mock;

const HEAD = "a".repeat(40);
const JOB = "pull / linux-jammy-py3.10-gcc11 / test";

function headRow(jobId: number, completedAt = "2026-10-09 10:00:00") {
  return {
    sha: HEAD,
    jobId: String(jobId),
    conclusion: "failure",
    fullName: JOB,
    htmlUrl: `https://github.com/pytorch/pytorch/actions/runs/1/job/${jobId}`,
    logUrl: "",
    startedAt: "2026-10-09 09:50:00",
    completedAt,
    failureCaptures: [],
    failureLines: [],
  };
}

// ClickHouse holds only `headRows` for the PR head; trunk lookups are empty.
function setUp(headRows: ReturnType<typeof headRow>[]) {
  const createWorkflowDispatch = jest.fn().mockResolvedValue({});
  mockGetOctokit.mockResolvedValue({
    rest: { actions: { createWorkflowDispatch } },
  });
  mockQuery.mockImplementation(async (name: string) =>
    name === "advisor_job_status_exact" ? headRows : []
  );
  return createWorkflowDispatch;
}

const params = {
  owner: "pytorch",
  repo: "pytorch",
  prNumber: 1,
  headSha: HEAD,
  jobName: JOB,
  mergeBaseSha: "b".repeat(40),
};

const RUNNING = "1970-01-01 00:00:00.000000000";

describe("dispatchAdvisorWorkflow evidence check", () => {
  afterEach(() => jest.resetAllMocks());

  it("dispatches when the evidence holds the named run, completed", async () => {
    const dispatch = setUp([headRow(2), headRow(1)]);
    await dispatchAdvisorWorkflow({ ...params, jobId: 2 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  // Dr.CI saw job 2, but this read is behind it.
  it("refuses when the evidence does not hold the named run", async () => {
    const dispatch = setUp([headRow(1)]);
    await expect(
      dispatchAdvisorWorkflow({ ...params, jobId: 2 })
    ).rejects.toThrow(/job 2 is not completed/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  // ClickHouse still has the run's in-progress snapshot.
  it("refuses when the named run is in the evidence but not completed", async () => {
    const dispatch = setUp([headRow(2, RUNNING), headRow(1)]);
    await expect(
      dispatchAdvisorWorkflow({ ...params, jobId: 2 })
    ).rejects.toThrow(/job 2 is not completed/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  // Workflow-level failures and the manual button name no run.
  it("does not check when no run is named", async () => {
    const dispatch = setUp([]);
    await dispatchAdvisorWorkflow(params);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

// The auto loop with the real dispatcher: ClickHouse and GitHub are mocked,
// dispatch rows are kept in memory the way readDispatchStates would see them.
describe("auto-dispatch against ClickHouse evidence", () => {
  const OLD_ENV = process.env;
  const KEY = drciSignalKeyForJob(JOB);
  let rows: { state: string; jobId: number; retryCount: number }[];
  let clock: number;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.DRCI_ADVISOR_AUTODISPATCH_ENABLED = "true";
    process.env.VERCEL_ENV = "production";
    rows = [];
    clock = Date.UTC(2026, 9, 9, 10, 0, 12);
  });
  afterEach(() => {
    process.env = OLD_ENV;
    jest.resetAllMocks();
  });

  const version = (ms: number) =>
    new Date(ms).toISOString().replace("T", " ").replace("Z", "");

  function latest(): DispatchStateRow | undefined {
    const r = rows[rows.length - 1];
    return r && { ...r, state: r.state as any, version: version(clock) };
  }

  function deps(): AutoDispatchDeps {
    return {
      readDispatchStates: jest.fn(async () => {
        const r = latest();
        return new Map(r ? [[KEY, r]] : []);
      }),
      recordDispatch: jest.fn(async (rec) => {
        rows.push({
          state: rec.state,
          jobId: rec.jobId ?? 0,
          retryCount: rec.retryCount,
        });
        return version(clock);
      }),
      dispatchAdvisorWorkflow,
      getPullRequestMeta: jest
        .fn()
        .mockResolvedValue({ state: "open", draft: false, labels: [] }),
    };
  }

  const run = (id: number, completedAt: string) =>
    ({
      name: JOB,
      conclusion: "failure",
      failure_captures: [],
      completed_at: completedAt,
      id,
      workflowId: 10,
    } as unknown as RecentWorkflowsData);

  const pass = (job: RecentWorkflowsData, verdictAt?: string) =>
    autoDispatchAdvisorForNewFailures(
      {
        owner: "pytorch",
        repo: "pytorch",
        prNumber: 1,
        headSha: HEAD,
        newFailures: [job],
        verdictRows: verdictAt
          ? [
              {
                sha: HEAD,
                signal_key: KEY,
                verdict: "not_related",
                confidence: 0.95,
                timestamp: verdictAt,
              } as unknown as AdvisorVerdictRow,
            ]
          : [],
      },
      deps()
    );

  // The 2026-10-09 case: the rerun (job 2) finished 12s before the dispatch
  // but reached ClickHouse 46s after it, so Dr.CI and the evidence both had
  // only job 1. The row records job 1; its verdict does not clear job 2, and
  // job 2 is dispatched once that verdict lands.
  it("does not let job 1's verdict clear the rerun that missed the dispatch", async () => {
    setUp([headRow(1)]);
    await pass(run(1, "2026-10-09 09:58:00"));
    expect(rows.map((r) => [r.state, r.jobId])).toEqual([
      ["dispatching", 1],
      ["dispatched", 1],
    ]);

    const rerun = run(2, "2026-10-09 10:00:00");
    const mark = toDispatchMark(latest()!);
    const VERDICT = "2026-10-09 10:03:00";
    // #9139's time test alone would count the verdict for the rerun.
    expect(
      verdictCoversRun(VERDICT, rerun.completed_at, { ...mark, jobId: 0 })
    ).toBe(true);
    expect(verdictCoversRun(VERDICT, rerun.completed_at, mark, 2)).toBe(false);
    expect(ranAfterDispatch(rerun, mark)).toBe(true);

    setUp([headRow(2), headRow(1)]);
    await pass(rerun, VERDICT);
    expect(rows.slice(2).map((r) => [r.state, r.jobId])).toEqual([
      ["dispatching", 2],
      ["dispatched", 2],
    ]);
  });

  // Dr.CI saw job 2 before the evidence read did: the dispatch is refused and
  // recorded as failed, the comment keeps the pending sentinel, and the next
  // pass dispatches it once ClickHouse has the run.
  it("refuses, keeps the PR pending, and recovers when the run arrives", async () => {
    setUp([headRow(1)]);
    const job2 = run(2, "2026-10-09 10:00:00");
    await pass(job2);
    expect(rows.map((r) => [r.state, r.jobId, r.retryCount])).toEqual([
      ["dispatching", 2, 0],
      ["failed", 2, 0],
    ]);
    const mark = toDispatchMark(latest()!);
    expect(mark.retryPending).toBe(true);
    const line = selectAdvisorLines(
      "https://hud.pytorch.org",
      "pytorch",
      "pytorch",
      1,
      HEAD,
      [{ id: 2, name: JOB, completedAt: job2.completed_at, runId: 2 }],
      new Map(),
      new Map([[KEY, mark]])
    ).get(2);
    expect(line).toContain(ADVISOR_PENDING_ALT_ATTR);

    setUp([headRow(2), headRow(1)]);
    await pass(job2);
    expect(rows.slice(2).map((r) => [r.state, r.jobId, r.retryCount])).toEqual([
      ["dispatching", 2, 1],
      ["dispatched", 2, 1],
    ]);
  });

  // Dr.CI first dispatched job 7 (an older workflow run's retry); once the
  // newer workflow run reached ClickHouse it picks that run's job 6. Job 6 is
  // analyzed after job 7's verdict lands, rather than staying pending.
  it("follows Dr.CI's pick to a lower job id", async () => {
    setUp([headRow(7), headRow(6)]);
    await pass(run(7, "2026-10-09 10:00:00"));
    await pass(run(6, "2026-10-09 09:58:00"), "2026-10-09 10:03:00");
    expect(rows.slice(2).map((r) => [r.state, r.jobId])).toEqual([
      ["dispatching", 6],
      ["dispatched", 6],
    ]);
  });

  it("gives a new run its own retries after another run exhausted them", async () => {
    setUp([headRow(1)]);
    for (let i = 0; i < 4; i++) await pass(run(7, "2026-10-09 10:00:00"));
    expect(rows[rows.length - 1]).toEqual(
      expect.objectContaining({ state: "failed", jobId: 7, retryCount: 3 })
    );
    setUp([headRow(8), headRow(1)]);
    await pass(run(8, "2026-10-09 10:10:00"));
    expect(rows.slice(-2).map((r) => [r.state, r.jobId, r.retryCount])).toEqual(
      [
        ["dispatching", 8, 0],
        ["dispatched", 8, 0],
      ]
    );
  });

  it("stops after the retry limit while ClickHouse never has the run", async () => {
    setUp([headRow(1)]);
    const job2 = run(2, "2026-10-09 10:00:00");
    for (let i = 0; i < 6; i++) await pass(job2);
    // One attempt plus MAX_DISPATCH_RETRIES (3) retries, then nothing.
    expect(rows.filter((r) => r.state === "dispatching")).toHaveLength(4);
    expect(rows.every((r) => r.state !== "dispatched")).toBe(true);
  });
});
