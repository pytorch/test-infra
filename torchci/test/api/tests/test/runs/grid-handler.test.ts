import { GET } from "app/api/tests/test/[test_id]/runs/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import * as grid from "lib/api/tests/test/runs/grid";
import * as list from "lib/api/tests/test/runs/list";
import { RunGrid, RunGridSchema } from "lib/api/tests/test/runs/types";
import { callRoute } from "test/api/routes";
import { TEST_ID } from "./fixtures";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const emptyGrid: RunGrid = {
  commits: [],
  lanes: [],
  hud_url: null,
  query_duration_ms: 3,
};

function get(query: RawQuery) {
  return callRoute(GET, "/api/tests/test/{test_id}/runs", {
    test_id: TEST_ID,
    ...query,
  });
}

describe("GET /api/tests/test/{test_id}/runs?group_by=commit", () => {
  let queryRunGrid: jest.SpyInstance;
  let listRuns: jest.SpyInstance;

  beforeEach(() => {
    queryRunGrid = jest
      .spyOn(grid, "queryRunGrid")
      .mockResolvedValue(emptyGrid);
    listRuns = jest.spyOn(list, "listRuns");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("answers the grid for the parsed query and never pages", async () => {
    const res = await get({
      group_by: "commit",
      ran_on: "pull_request,main",
      window: "7d",
      workflow_path: [".github/workflows/pull.yml"],
    });
    expect(res.status).toBe(200);
    expect(RunGridSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toEqual(emptyGrid);
    expect(queryRunGrid).toHaveBeenCalledWith({
      test_id: TEST_ID,
      group_by: "commit",
      ran_on: ["main", "pull_request"],
      window: "7d",
      workflow_path: [".github/workflows/pull.yml"],
    });
    expect(listRuns).not.toHaveBeenCalled();
  });

  test.each([
    ["sort", "-started_at"],
    ["limit", "5"],
    ["cursor", "abc"],
    ["search", "add"],
    ["outcome", "failed"],
    ["last_attempt_outcome", "passed"],
    ["rerun_number", "0"],
  ])("rejects %s, a parameter of a page of bundles", async (name, value) => {
    const res = await get({ group_by: "commit", [name]: value });
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.code).toBe("invalid_parameters");
    expect(res.body.error).toBe(
      `${name}: ${name} does not apply with group_by=commit`
    );
    expect(res.body.issues).toEqual([
      { path: [name], message: `${name} does not apply with group_by=commit` },
    ]);
    expect(queryRunGrid).not.toHaveBeenCalled();
  });

  test.each([
    { group_by: "run" },
    { group_by: "" },
    { group_by: ["commit", "commit"] },
    { group_by: "commit", bogus: "1" },
    { group_by: "commit", ran_on: "trunk" },
    { group_by: "commit", ran_on: "" },
    { group_by: "commit", window: "2d" },
    { group_by: "commit", window: ["7d", "3d"] },
    { group_by: "commit", device_count: "x" },
  ])("rejects invalid grid parameters %j", async (query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_parameters");
    expect(queryRunGrid).not.toHaveBeenCalled();
  });

  test("rejects the grid's own parameters on a page of bundles", async () => {
    for (const query of [{ ran_on: "main" }, { window: "7d" }]) {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_parameters");
    }
    expect(listRuns).not.toHaveBeenCalled();
  });

  test("answers a failed query with 500 and no details", async () => {
    queryRunGrid.mockRejectedValue(new Error("boom"));
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await get({ group_by: "commit" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Failed to group test runs by commit",
      code: "internal_error",
    });
    expect(error).toHaveBeenCalled();
  });
});
