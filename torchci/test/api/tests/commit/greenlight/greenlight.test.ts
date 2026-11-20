import { GET } from "app/api/tests/commit/[sha]/greenlight/route";
import {
  getCommitGreenlight,
  GREENLIGHT_HISTORY_QUERY,
} from "lib/api/tests/commit/greenlight/greenlight";
import {
  CommitGreenlightSchema,
  GREENLIGHT_STATUSES,
} from "lib/api/tests/commit/greenlight/types";
import * as clickhouse from "lib/clickhouse";
import type { GreenlightPrStateRow } from "lib/greenlight/greenlightHudState";
import { callRoute } from "test/api/routes";

// GreenLight's verdict on a commit: which pull request's ledger is read,
// with what, and which of its rows is the commit's. The commit's own lookup
// and the ledger are the mocked ClickHouse; the saved query runs through the
// real queryClickhouseSaved, so its parameters are the ones production binds.

jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const REPO = "pytorch/pytorch";
const ROUTE = "/api/tests/commit/{sha}/greenlight";
// Pull request 204301 on 2026-11-10: GreenLight approved its head 841ef2a,
// which the merge bot landed on main as 80227b3.
const HEAD = "841ef2a4d54042f2f2c8930627d799c94cba4ad0";
const EARLIER_HEAD = "098887e0c98b6c4c726e6d1ccc997d7cc2982469";
const LANDED = "80227b3622d3d062ad5ea7d561a8e6a6598a78c5";
const LANDED_AT_MS = Date.parse("2026-11-11T07:07:43.000Z");
const JOB = "https://github.com/pytorch/test-infra/actions/runs/42910116063";
const MESSAGE =
  "- Triviality\n  - Mechanical refactor: moves two method bodies into module functions";

// The commit's lookup row, as buildCommitInfoQuery returns it: a pull
// request head unless overridden.
function infoRow(overrides: Record<string, unknown> = {}) {
  return {
    workflow_runs: 12,
    workflow_message: "[INITIAL] Update",
    workflow_author_name: "Angel Li",
    workflow_committed_at_ms: Date.parse("2026-11-10T21:54:38.000Z"),
    push_branches: [],
    pull_requests: [
      [204301, "https://api.github.com/repos/pytorch/pytorch/pulls/204301"],
    ],
    pull_request_branch: "gh/liangel-02/201/head",
    pushes: 0,
    author_login: "",
    push_message: "",
    push_author_name: "",
    push_committed_at_ms: 0,
    refs: [],
    ...overrides,
  };
}

// The lookup row of the commit on main the head landed as.
function landedInfoRow(overrides: Record<string, unknown> = {}) {
  return infoRow({
    workflow_message:
      "[FakeTensor] Extract real-output validation helpers (#204301)\n\nBody.",
    workflow_committed_at_ms: LANDED_AT_MS,
    push_branches: ["main"],
    pull_requests: [],
    pull_request_branch: "",
    pushes: 1,
    author_login: "liangel-02",
    refs: ["refs/heads/main"],
    ...overrides,
  });
}

function ledgerRow(
  overrides: Partial<GreenlightPrStateRow> = {}
): GreenlightPrStateRow {
  return {
    pr_number: 204301,
    head_sha: HEAD,
    merge_commit_sha: "",
    status: "LAND",
    reason: "clean",
    message: MESSAGE,
    eval_job: JOB,
    run_id: 42910116063,
    // As ClickHouse serves a DateTime64 under the client's iso format: no
    // zone designator.
    version: "2026-11-10T22:00:33.865000",
    ...overrides,
  };
}

function answer(
  queryClickhouse: jest.SpyInstance,
  answers: {
    info?: Record<string, unknown>[];
    pullRequestByHead?: Record<string, unknown>[];
    history?: GreenlightPrStateRow[];
  }
) {
  queryClickhouse.mockImplementation(async (_sql, _params, queryId) => {
    switch (queryId) {
      case "api_commit_greenlight_info":
        return answers.info ?? [infoRow()];
      case "api_commit_greenlight_pull_request_by_head":
        return answers.pullRequestByHead ?? [];
      case GREENLIGHT_HISTORY_QUERY:
        return answers.history ?? [ledgerRow()];
      default:
        throw new Error(`unexpected query ${queryId}`);
    }
  });
}

// The parameters each query was given, by its query id.
function parametersOf(queryClickhouse: jest.SpyInstance) {
  return Object.fromEntries(
    queryClickhouse.mock.calls.map((call) => [call[2], call[1]])
  );
}

describe("GET /api/tests/commit/{sha}/greenlight", () => {
  let queryClickhouse: jest.SpyInstance;
  beforeEach(() => {
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("a pull request head answers with its own status, read by its pull request alone", async () => {
    answer(queryClickhouse, {
      history: [ledgerRow({ head_sha: EARLIER_HEAD }), ledgerRow()],
    });
    const res = await callRoute(GET, ROUTE, { sha: HEAD, repo: REPO });
    expect(res.status).toBe(200);
    expect(CommitGreenlightSchema.parse(res.body)).toEqual(res.body);
    expect(res.body).toEqual({
      verdict: {
        status: "LAND",
        reason: "clean",
        message: MESSAGE,
        pull_request_number: 204301,
        head_sha: HEAD,
        updated_at: "2026-11-10T22:00:33.865Z",
        job_url: JOB,
      },
      no_verdict_reason: null,
      hud_url: `https://hud.pytorch.org/tests/pytorch/pytorch/commit/${HEAD}`,
      query_duration_ms: expect.any(Number),
    });
    // The head is matched as it is: the query is given neither the commit
    // nor its timestamp, from which it would tag the head pushed before it.
    expect(parametersOf(queryClickhouse)).toEqual({
      api_commit_greenlight_info: { sha: HEAD, repo: REPO },
      [GREENLIGHT_HISTORY_QUERY]: {
        repo: REPO,
        owner: "pytorch",
        project: "pytorch",
        prNumber: 204301,
        sha: "",
        committedAt: "",
      },
    });
    // Neither read is in the heavy workload, and neither is cached: a
    // review in flight is asked about again.
    for (const call of queryClickhouse.mock.calls) {
      expect([call[3], call[4]]).toEqual([undefined, undefined]);
    }
  });

  test("a commit on a branch answers with the status of the head that landed as it", async () => {
    answer(queryClickhouse, {
      info: [landedInfoRow()],
      history: [
        ledgerRow({ head_sha: EARLIER_HEAD }),
        ledgerRow({ merge_commit_sha: LANDED }),
      ],
    });
    const greenlight = await getCommitGreenlight({ sha: LANDED, repo: REPO });
    expect(greenlight.verdict).toMatchObject({
      status: "LAND",
      pull_request_number: 204301,
      // The head that was reviewed, not the commit asked about.
      head_sha: HEAD,
    });
    expect(greenlight.hud_url).toBe(
      `https://hud.pytorch.org/tests/pytorch/pytorch/commit/${LANDED}`
    );
    // The pull request is the one the commit's title ends in, and the query
    // is given the commit and its timestamp, the committer's, to recover
    // the head from.
    expect(parametersOf(queryClickhouse)[GREENLIGHT_HISTORY_QUERY]).toEqual({
      repo: REPO,
      owner: "pytorch",
      project: "pytorch",
      prNumber: 204301,
      sha: LANDED,
      committedAt: "2026-11-11T07:07:43.000Z",
    });
  });

  test("never answers with another head's status: the commit was not reviewed", async () => {
    // The pull request was reviewed, at heads this commit is neither of.
    answer(queryClickhouse, {
      history: [
        ledgerRow({ head_sha: EARLIER_HEAD }),
        ledgerRow({ head_sha: EARLIER_HEAD, merge_commit_sha: LANDED }),
      ],
    });
    const greenlight = await getCommitGreenlight({ sha: HEAD, repo: REPO });
    expect(greenlight.verdict).toBeNull();
    expect(greenlight.no_verdict_reason).toBe("not_reviewed");
    expect(greenlight.query_duration_ms).toEqual(expect.any(Number));
    expect(CommitGreenlightSchema.parse(greenlight)).toEqual(greenlight);
  });

  test("a pull request GreenLight recorded nothing for was not reviewed", async () => {
    answer(queryClickhouse, { history: [] });
    const greenlight = await getCommitGreenlight({ sha: HEAD, repo: REPO });
    expect(greenlight).toMatchObject({
      verdict: null,
      no_verdict_reason: "not_reviewed",
    });
  });

  test("a pull request from a fork is found by the commit's SHA", async () => {
    answer(queryClickhouse, {
      info: [infoRow({ pull_requests: [], pull_request_branch: "" })],
      pullRequestByHead: [
        {
          number: 204301,
          title: "[FakeTensor] Extract real-output validation helpers",
          html_url: "https://github.com/pytorch/pytorch/pull/204301",
          head_branch: "extract-helpers",
        },
      ],
    });
    const greenlight = await getCommitGreenlight({ sha: HEAD, repo: REPO });
    expect(greenlight.verdict?.status).toBe("LAND");
    // A head: matched as it is, with no timestamp.
    expect(parametersOf(queryClickhouse)[GREENLIGHT_HISTORY_QUERY]).toEqual(
      expect.objectContaining({ prNumber: 204301, sha: "", committedAt: "" })
    );
  });

  test("a commit with no pull request has no verdict, and the ledger is not read", async () => {
    // A merge bot's revert: on main, its title ending in no pull request.
    answer(queryClickhouse, {
      info: [
        landedInfoRow({
          workflow_message: 'Revert "[FakeTensor] Extract helpers (#204301)"',
        }),
      ],
    });
    const greenlight = await getCommitGreenlight({ sha: LANDED, repo: REPO });
    expect(greenlight.verdict).toBeNull();
    expect(greenlight.no_verdict_reason).toBe("no_pull_request");
    expect(queryClickhouse.mock.calls.map((call) => call[2])).toEqual([
      "api_commit_greenlight_info",
    ]);
  });

  test("a commit HUD never heard of has no verdict, not a 404", async () => {
    answer(queryClickhouse, {
      info: [infoRow({ workflow_runs: 0, pushes: 0 })],
    });
    const res = await callRoute(GET, ROUTE, { sha: HEAD, repo: REPO });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBeNull();
    expect(res.body.no_verdict_reason).toBe("unknown_commit");
    expect(queryClickhouse).toHaveBeenCalledTimes(1);
  });

  test("a repository GreenLight does not review is answered without a query", async () => {
    answer(queryClickhouse, {});
    const greenlight = await getCommitGreenlight({
      sha: HEAD,
      repo: "pytorch/vision",
    });
    expect(greenlight).toEqual({
      verdict: null,
      no_verdict_reason: "repository_not_reviewed",
      hud_url: `https://hud.pytorch.org/tests/pytorch/vision/commit/${HEAD}`,
      query_duration_ms: 0,
    });
    expect(queryClickhouse).not.toHaveBeenCalled();
  });

  test("the ledger's repository is matched whatever the request's case", async () => {
    answer(queryClickhouse, {});
    await getCommitGreenlight({ sha: HEAD, repo: "PyTorch/PyTorch" });
    expect(parametersOf(queryClickhouse)[GREENLIGHT_HISTORY_QUERY]).toEqual(
      expect.objectContaining({
        // The ledger's key is folded; the merge bot's record is read by the
        // names as given.
        repo: "pytorch/pytorch",
        owner: "PyTorch",
        project: "PyTorch",
      })
    );
  });

  test.each(GREENLIGHT_STATUSES.map((status) => [status]))(
    "answers the ledger's status %s as it is spelled",
    async (status) => {
      answer(queryClickhouse, {
        history: [
          ledgerRow({ status: ` ${status} `, reason: "", message: "" }),
        ],
      });
      const greenlight = await getCommitGreenlight({ sha: HEAD, repo: REPO });
      expect(greenlight.verdict).toMatchObject({
        status,
        reason: "",
        message: "",
      });
      // A reason is given only where there is no verdict.
      expect(greenlight.no_verdict_reason).toBeNull();
      expect(CommitGreenlightSchema.parse(greenlight)).toEqual(greenlight);
    }
  );

  test("a status outside the ledger's vocabulary is no verdict, and said to be one", async () => {
    answer(queryClickhouse, { history: [ledgerRow({ status: "PENDING" })] });
    const greenlight = await getCommitGreenlight({ sha: HEAD, repo: REPO });
    expect(greenlight.verdict).toBeNull();
    // Not "not reviewed": GreenLight recorded something for the commit.
    expect(greenlight.no_verdict_reason).toBe("unrecognized_status");
    expect(CommitGreenlightSchema.parse(greenlight)).toEqual(greenlight);
  });

  test.each([
    ["", null],
    ["   ", null],
    [JOB, JOB],
    [` ${JOB} `, JOB],
    ["http://github.com/pytorch/test-infra/actions/runs/1", null],
    ["https://github.com.example/pytorch/test-infra/actions/runs/1", null],
    ["https://user:pass@github.com/pytorch/test-infra/actions/runs/1", null],
    ["https://github.com/pytorch/test-infra/actions/runs/1 onclick=x", null],
    ["javascript:alert(1)", null],
  ])("the job %j is linked as %j", async (recorded, linked) => {
    answer(queryClickhouse, { history: [ledgerRow({ eval_job: recorded })] });
    const greenlight = await getCommitGreenlight({ sha: HEAD, repo: REPO });
    expect(greenlight.verdict?.job_url).toBe(linked);
  });

  test.each([
    ["2026-11-10T22:00:33.865000", "2026-11-10T22:00:33.865Z"],
    ["2026-11-10 22:00:33.865", "2026-11-10T22:00:33.865Z"],
    ["2026-11-10T22:00:33Z", "2026-11-10T22:00:33.000Z"],
    ["2026-11-10T22:00:33.865+00:00", "2026-11-10T22:00:33.865Z"],
  ])("the ledger's time %s is answered in UTC as %s", async (version, iso) => {
    answer(queryClickhouse, { history: [ledgerRow({ version })] });
    const greenlight = await getCommitGreenlight({ sha: HEAD, repo: REPO });
    expect(greenlight.verdict?.updated_at).toBe(iso);
  });

  test("a row whose time cannot be read fails the request rather than pass for no verdict", async () => {
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    answer(queryClickhouse, { history: [ledgerRow({ version: "soon" })] });
    const res = await callRoute(GET, ROUTE, { sha: HEAD, repo: REPO });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Failed to read the commit's GreenLight verdict",
      code: "internal_error",
    });
    expect(logged).toHaveBeenCalled();
  });

  test("a failed read is a 500 with no detail", async () => {
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    queryClickhouse.mockRejectedValue(new Error("connection reset"));
    const res = await callRoute(GET, ROUTE, { sha: HEAD, repo: REPO });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Failed to read the commit's GreenLight verdict",
      code: "internal_error",
    });
    expect(logged).toHaveBeenCalled();
  });

  test("a message that is not a string is answered empty", async () => {
    answer(queryClickhouse, {
      history: [ledgerRow({ message: { nested: true } as unknown as string })],
    });
    const greenlight = await getCommitGreenlight({ sha: HEAD, repo: REPO });
    expect(greenlight.verdict?.message).toBe("");
  });

  test("the SHA is matched whatever its case in the request and the ledger", async () => {
    answer(queryClickhouse, {
      history: [ledgerRow({ head_sha: HEAD.toUpperCase() })],
    });
    const res = await callRoute(GET, ROUTE, {
      sha: HEAD.toUpperCase(),
      repo: REPO,
    });
    expect(res.status).toBe(200);
    expect(res.body.verdict.head_sha).toBe(HEAD);
    expect(res.body.hud_url).toBe(
      `https://hud.pytorch.org/tests/pytorch/pytorch/commit/${HEAD}`
    );
  });
});
