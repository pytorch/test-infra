import { GET } from "app/api/tests/commit/[sha]/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema, ListPageData } from "lib/api/schema";
import {
  CommitRunsCursor,
  encodeCommitRunsCursor,
} from "lib/api/tests/commit/cursor";
import * as list from "lib/api/tests/commit/list";
import {
  CommitRunListPage,
  CommitRunListPageSchema,
} from "lib/api/tests/commit/types";
import { callRoute } from "test/api/routes";
import { expandedRunRecord, runRecord, runStats } from "../test/runs/fixtures";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "pytorch/pytorch";
const emptyPage: ListPageData<CommitRunListPage> = {
  runs: [],
  next_cursor: null,
  previous_cursor: null,
  query_duration_ms: 7,
  stats: runStats(),
};
const cursor: CommitRunsCursor = {
  version: 2,
  resource: "commit-runs",
  query: {
    sha: SHA,
    repo: REPO,
    environments_id: ["10", "11"],
    env_vars_id: ["20"],
    outcome: ["error", "failed"],
    sort: ["-started_at"],
  },
  position: { values: ["1790000000123", "123", "10", "20", "-1"] },
};

function get(query: RawQuery = { sha: SHA, repo: REPO }) {
  return callRoute(GET, "/api/tests/commit/{sha}", query);
}

describe("app/api/tests/commit/[sha]", () => {
  let listCommitRuns: jest.SpyInstance;

  beforeEach(() => {
    listCommitRuns = jest
      .spyOn(list, "listCommitRuns")
      .mockResolvedValue(emptyPage);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    {},
    { sha: SHA },
    { repo: REPO },
    { sha: "invalid", repo: REPO },
    { sha: [SHA], repo: REPO },
    { sha: SHA, repo: "invalid" },
    { sha: SHA, repo: [REPO, REPO] },
    { sha: SHA, repo: REPO, test_id: "123" },
    { sha: SHA, repo: REPO, environments_id: "invalid" },
    { sha: SHA, repo: REPO, env_vars_id: "1,2" },
    { sha: SHA, repo: REPO, outcome: "FAILED" },
    { sha: SHA, repo: REPO, outcome: "failed,error" },
    { sha: SHA, repo: REPO, sort: "started_at,-started_at" },
    { sha: SHA, repo: REPO, limit: "101" },
    { sha: SHA, repo: REPO, cursor: "invalid-cursor" },
    { sha: SHA, repo: REPO, cursor: "" },
  ])("rejects invalid parameters before querying %j", async (query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(
      "cursor" in query ? "invalid_cursor" : "invalid_parameters"
    );
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(listCommitRuns).not.toHaveBeenCalled();
  });

  test("passes normalized SHA, repeated filters and sort priorities to the query", async () => {
    const run = runRecord({ github_workflow_job_id: "120104808456" });
    const page: ListPageData<CommitRunListPage> = {
      ...emptyPage,
      stats: runStats(Array(147).fill("failed")),
      runs: [
        {
          ...expandedRunRecord(run),
          github_workflow: {
            job_id: run.github_workflow_job_id,
            run_id: "9007199254740993",
            path: ".github/workflows/trunk.yml",
            commit_sha: SHA,
            job_url:
              "https://github.com/pytorch/pytorch/actions/runs/9007199254740993/job/120104808456",
            job_name:
              "linux-jammy-py3.10-gcc11 / test (default, 1, 5, linux.4xlarge)",
            event: "push",
            pull_request: null,
          },
          test: {
            id: run.tests_id,
            hud_url: `https://hud.pytorch.org/tests/${REPO}/test/${run.tests_id}`,
            repo: REPO,
            file: "test/test_torch.py",
            suite: "TestTorch",
            case_name: "test_add_cpu_float32",
            declared_case_name: "test_add",
            language: "python",
            first_seen_at: "2026-10-14T06:57:57.812Z",
          },
          environment: null,
          env_vars: {
            id: run.env_vars_id,
            values: { PYTORCH_TEST_WITH_INDUCTOR: "1" },
            first_seen_at: "2026-10-13T19:03:23.252Z",
          },
          owners: ["nn"],
        },
      ],
    };
    listCommitRuns.mockResolvedValue(page);
    const res = await get({
      sha: SHA.toUpperCase(),
      repo: REPO,
      environments_id: ["9007199254740993", "02", "2"],
      env_vars_id: ["8", "7", "8"],
      outcome: ["failed", "error", "failed"],
      sort: "-ended_at,started_at",
      limit: "50",
    });
    expect(res.status).toBe(200);
    expect(listCommitRuns).toHaveBeenCalledTimes(1);
    expect(listCommitRuns).toHaveBeenCalledWith({
      query: {
        sha: SHA,
        repo: REPO,
        environments_id: ["2", "9007199254740993"],
        env_vars_id: ["7", "8"],
        outcome: ["error", "failed"],
        sort: ["-ended_at", "started_at"],
        limit: 50,
      },
      cursor: null,
    });
    const {
      next_cursor: _cursor,
      previous_cursor: _previousCursor,
      ...expectedPage
    } = page;
    expect(res.body).toEqual({
      ...expectedPage,
      pagination: { next: null, previous: null },
    });
    expect(res.body.runs[0].github_workflow).not.toHaveProperty(
      "pull_requests"
    );
    expect(CommitRunListPageSchema.parse(res.body)).toEqual(res.body);
    expect(res.body.stats).toEqual(runStats(Array(147).fill("failed")));
    expect(res.body.stats).toMatchObject({ total: 147, failed: 147 });
    expect(
      Object.keys(res.body.stats).some((field) => field.endsWith("_runs"))
    ).toBe(false);
    expect(res.body).not.toHaveProperty("total_runs");
    for (const name of [
      "tests_id",
      "environments_id",
      "env_vars_id",
      "github_workflow_job_id",
      "github_workflow_run_id",
      "workflow_path",
      "commit_sha",
      "github_workflow_job_url",
      "github_workflow_job_name",
      "workflow_event",
      "workflow_pull_requests",
      "workflow_pull_request",
      "workflow_metadata_available",
      "workflow_repository_id",
      "github_workflow_run_url",
    ]) {
      expect(res.body.runs[0]).not.toHaveProperty(name);
    }
  });

  test("names the invalid filter and repeated-value index in a 400", async () => {
    const res = await get({ sha: SHA, repo: REPO, env_vars_id: "invalid" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "env_vars_id.0: must be a UInt64 decimal string",
      code: "invalid_parameters",
      issues: [
        {
          path: ["env_vars_id", 0],
          message: "must be a UInt64 decimal string",
        },
      ],
    });
    expect(listCommitRuns).not.toHaveBeenCalled();
  });

  test("returns an empty page for a commit with no matching runs", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const {
      next_cursor: _cursor,
      previous_cursor: _previousCursor,
      ...expectedPage
    } = emptyPage;
    expect(CommitRunListPageSchema.parse(res.body)).toEqual({
      ...expectedPage,
      pagination: { next: null, previous: null },
    });
    expect(listCommitRuns).toHaveBeenCalledWith({
      query: { sha: SHA, repo: REPO, sort: ["-started_at"], limit: 25 },
      cursor: null,
    });
  });

  test("accepts the same cursor with equivalent SHA and filters and a different page size", async () => {
    const res = await get({
      sha: SHA.toUpperCase(),
      repo: REPO,
      environments_id: ["11", "010", "11"],
      env_vars_id: "020",
      outcome: ["failed", "error", "failed"],
      limit: "1",
      cursor: encodeCommitRunsCursor(cursor),
    });
    expect(res.status).toBe(200);
    expect(listCommitRuns).toHaveBeenCalledWith({
      query: { ...cursor.query, limit: 1 },
      cursor,
    });
  });

  test.each([
    { sha: "0".repeat(40) },
    { repo: "pytorch/vision" },
    { environments_id: ["10"] },
    { environments_id: undefined },
    { env_vars_id: "21" },
    { env_vars_id: undefined },
    { outcome: "failed" },
    { outcome: undefined },
    { sort: "started_at" },
    { sort: "-ended_at" },
  ])("rejects a cursor when its query changes %j", async (override) => {
    const res = await get({
      sha: SHA,
      repo: REPO,
      environments_id: ["10", "11"],
      env_vars_id: "20",
      outcome: ["error", "failed"],
      ...override,
      cursor: encodeCommitRunsCursor(cursor),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different request/i);
    expect(res.body.code).toBe("cursor_query_mismatch");
    expect(res.body).not.toHaveProperty("issues");
    expect(listCommitRuns).not.toHaveBeenCalled();
  });

  test("rejects a cursor issued for the individual test runs endpoint", async () => {
    const otherResource = {
      version: 2,
      resource: "test-runs",
      query: { test_id: "123", sort: ["-started_at"] },
      position: { values: ["1790000000123", "10", "20", "-1"] },
    };
    const res = await get({
      sha: SHA,
      repo: REPO,
      cursor: Buffer.from(JSON.stringify(otherResource)).toString("base64url"),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/returned by this endpoint/i);
    expect(res.body.code).toBe("invalid_cursor");
    expect(res.body).not.toHaveProperty("issues");
    expect(listCommitRuns).not.toHaveBeenCalled();
  });

  test("logs failures and returns 500 without exposing database details", async () => {
    listCommitRuns.mockRejectedValue(
      new Error("private database connection failed")
    );
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Failed to list commit test runs",
      code: "internal_error",
    });
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(consoleError).toHaveBeenCalled();
  });
});
