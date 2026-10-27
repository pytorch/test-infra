import { GET } from "app/api/tests/test/[test_id]/runs/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema, ListPageData } from "lib/api/schema";
import { encodeRunsCursor, RunsCursor } from "lib/api/tests/test/runs/cursor";
import * as list from "lib/api/tests/test/runs/list";
import { RunListPage, RunListPageSchema } from "lib/api/tests/test/runs/types";
import { callRoute } from "test/api/routes";
import { expandedRunRecord, runRecord } from "./fixtures";

const TEST_ID = "18446744073709551615";
const emptyPage: ListPageData<RunListPage> = {
  runs: [],
  next_cursor: null,
  previous_cursor: null,
  query_duration_ms: 7,
};
const cursor: RunsCursor = {
  version: 2,
  resource: "test-runs",
  query: {
    test_id: TEST_ID,
    environments_id: ["10", "11"],
    env_vars_id: ["20"],
    outcome: ["error", "failed"],
    sort: ["-started_at"],
  },
  position: { values: ["1790000000123", "10", "20", "-1"] },
};

function get(query: RawQuery = { test_id: TEST_ID }) {
  return callRoute(GET, "/api/tests/test/{test_id}/runs", query);
}

describe("app/api/tests/test/[test_id]/runs", () => {
  let listRuns: jest.SpyInstance;

  beforeEach(() => {
    listRuns = jest.spyOn(list, "listRuns").mockResolvedValue(emptyPage);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    {},
    { test_id: "invalid" },
    { test_id: "18446744073709551616" },
    { test_id: [TEST_ID] },
    { test_id: TEST_ID, environments_id: "invalid" },
    { test_id: TEST_ID, env_vars_id: "1,2" },
    { test_id: TEST_ID, outcome: "invalid" },
    { test_id: TEST_ID, outcome: "FAILED" },
    { test_id: TEST_ID, outcome: "failed,error" },
    { test_id: TEST_ID, outcome: "" },
    { test_id: TEST_ID, outcome: ["failed", "invalid"] },
    { test_id: TEST_ID, sort: "started_at,-started_at" },
    { test_id: TEST_ID, sort: "failure_rate" },
    { test_id: TEST_ID, repo: "pytorch/pytorch" },
    { test_id: TEST_ID, limit: "101" },
    { test_id: TEST_ID, cursor: "invalid-cursor" },
    { test_id: TEST_ID, cursor: "" },
  ])("rejects invalid parameters before querying %j", async (query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(
      "cursor" in query ? "invalid_cursor" : "invalid_parameters"
    );
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(listRuns).not.toHaveBeenCalled();
  });

  test("passes normalized IDs, repeated filters and sort priorities to listRuns", async () => {
    const run = runRecord({ github_workflow_job_id: "120104808456" });
    const page: ListPageData<RunListPage> = {
      ...emptyPage,
      runs: [
        {
          ...expandedRunRecord(run),
          github_workflow: {
            job_id: run.github_workflow_job_id,
            run_id: "9007199254740993",
            path: ".github/workflows/trunk.yml",
            commit_sha: "0123456789abcdef0123456789abcdef01234567",
            job_url:
              "https://github.com/pytorch/pytorch/actions/runs/9007199254740993/job/120104808456",
            job_name:
              "linux-jammy-py3.10-gcc11 / test (default, 1, 5, linux.4xlarge)",
            event: "pull_request",
            pull_request: {
              number: 123,
              url: "https://github.com/pytorch/pytorch/pull/123",
            },
          },
          test: {
            id: run.tests_id,
            repo: "pytorch/pytorch",
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
    listRuns.mockResolvedValue(page);
    const res = await get({
      test_id: "000123",
      environments_id: ["9007199254740993", "02", "2"],
      env_vars_id: ["8", "7", "8"],
      outcome: ["failed", "error", "failed"],
      sort: "-ended_at,started_at",
      limit: "50",
    });
    expect(res.status).toBe(200);
    expect(listRuns).toHaveBeenCalledTimes(1);
    expect(listRuns).toHaveBeenCalledWith({
      query: {
        test_id: "123",
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
    expect(RunListPageSchema.parse(res.body)).toEqual(res.body);
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

  test("names the invalid path parameter in a 400", async () => {
    const res = await get({ test_id: "invalid" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "test_id: must be a UInt64 decimal string",
      code: "invalid_parameters",
      issues: [
        { path: ["test_id"], message: "must be a UInt64 decimal string" },
      ],
    });
    expect(listRuns).not.toHaveBeenCalled();
  });

  test("returns an empty page for a test ID with no matching runs", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const {
      next_cursor: _cursor,
      previous_cursor: _previousCursor,
      ...expectedPage
    } = emptyPage;
    expect(RunListPageSchema.parse(res.body)).toEqual({
      ...expectedPage,
      pagination: { next: null, previous: null },
    });
    expect(listRuns).toHaveBeenCalledWith({
      query: { test_id: TEST_ID, sort: ["-started_at"], limit: 25 },
      cursor: null,
    });
  });

  test("accepts the same cursor filters in any repeated order with a different page size", async () => {
    const res = await get({
      test_id: TEST_ID,
      environments_id: ["11", "010", "11"],
      env_vars_id: "020",
      outcome: ["failed", "error", "failed"],
      limit: "1",
      cursor: encodeRunsCursor(cursor),
    });
    expect(res.status).toBe(200);
    expect(listRuns).toHaveBeenCalledWith({
      query: { ...cursor.query, limit: 1 },
      cursor,
    });
  });

  test.each([
    { test_id: "123" },
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
      test_id: TEST_ID,
      environments_id: ["10", "11"],
      env_vars_id: "20",
      outcome: ["error", "failed"],
      ...override,
      cursor: encodeRunsCursor(cursor),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different request/i);
    expect(res.body.code).toBe("cursor_query_mismatch");
    expect(res.body).not.toHaveProperty("issues");
    expect(listRuns).not.toHaveBeenCalled();
  });

  test("accepts existing unfiltered cursors and rejects adding an outcome filter", async () => {
    const unfilteredCursor: RunsCursor = {
      ...cursor,
      query: { test_id: TEST_ID, sort: ["-started_at"] },
    };
    const token = encodeRunsCursor(unfilteredCursor);
    const res = await get({ test_id: TEST_ID, cursor: token });
    expect(res.status).toBe(200);
    expect(listRuns).toHaveBeenCalledWith({
      query: { ...unfilteredCursor.query, limit: 25 },
      cursor: unfilteredCursor,
    });

    listRuns.mockClear();
    const filteredRes = await get({
      test_id: TEST_ID,
      outcome: "failed",
      cursor: token,
    });
    expect(filteredRes.status).toBe(400);
    expect(filteredRes.body.error).toMatch(/different request/i);
    expect(filteredRes.body.code).toBe("cursor_query_mismatch");
    expect(filteredRes.body).not.toHaveProperty("issues");
    expect(listRuns).not.toHaveBeenCalled();
  });

  test("rejects a cursor issued for another resource", async () => {
    const otherResource = { ...cursor, resource: "tests" };
    const res = await get({
      test_id: TEST_ID,
      cursor: Buffer.from(JSON.stringify(otherResource)).toString("base64url"),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/returned by this endpoint/i);
    expect(res.body.code).toBe("invalid_cursor");
    expect(res.body).not.toHaveProperty("issues");
    expect(listRuns).not.toHaveBeenCalled();
  });

  test("logs failures and returns 500 without exposing database details", async () => {
    listRuns.mockRejectedValue(new Error("private database connection failed"));
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Failed to list test runs",
      code: "internal_error",
    });
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(consoleError).toHaveBeenCalled();
  });
});
