import { GET } from "app/api/tests/route";
import { ErrorResponseSchema } from "lib/api/schema";
import { encodeCursor } from "lib/api/tests/cursor";
import * as list from "lib/api/tests/list";
import * as clickhouse from "lib/clickhouse";
import { baseCursor, getTests, UNSUPPORTED_ID_SORTS } from "./fixtures";

describe("app/api/tests", () => {
  let listPage: jest.SpyInstance;
  let queryClickhouse: jest.SpyInstance;

  beforeEach(() => {
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
    listPage = jest.spyOn(list, "listTests").mockResolvedValue({
      tests: [],
      next_cursor: null,
      previous_cursor: null,
      refreshed_at: null,
      query_duration_ms: 0,
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    { repo: undefined },
    { repo: "pytorch" },
    { repo: "pytorch/pytorch/extra" },
    { window: "2d" },
    { order: "desc" },
    { sort: "runs,-runs" },
    ...UNSUPPORTED_ID_SORTS.map((sort) => ({ sort })),
    { min_runs: "1" },
    { test_id: "123" },
    { test_id: ["123", "456"] },
    { cpu_architeture: "aarch64" },
    { workflow_paths: ".github/workflows/pull.yml" },
    { sort: "workflow_path" },
    { sort: "-workflow_path" },
    { "env_vars[]": "value" },
    { cursor: "not-a-cursor" },
  ])("rejects invalid requests before querying %j", async (query) => {
    const res = await getTests(query);
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(res.body.code).toBe(
      "cursor" in query ? "invalid_cursor" : "invalid_parameters"
    );
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(listPage).not.toHaveBeenCalled();
    expect(queryClickhouse).not.toHaveBeenCalled();
  });

  test.each(["__proto__", "constructor", "toString"])(
    "rejects a %s query parameter like any unknown parameter",
    async (name) => {
      const response = await GET(
        new Request(
          `https://hud.pytorch.org/api/tests?repo=pytorch/pytorch&${name}=x`
        )
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: `Unrecognized key: "${name}"`,
        code: "invalid_parameters",
        issues: [{ path: [name], message: `Unrecognized key: "${name}"` }],
      });
      expect(listPage).not.toHaveBeenCalled();
    }
  );

  test("passes the centrally normalized request to the list implementation", async () => {
    const res = await getTests({
      search: "Test_case[a, b]",
      owner: ["nn", "autograd", "nn"],
      file: ["test/test_torch.py", "test/test_nn.py", "test/test_torch.py"],
      os: ["windows", "linux", "windows"],
      accelerator: ["cpu", "cuda"],
      device_count: "0",
      workflow_path: [
        ".github/workflows/trunk.yml",
        ".github/workflows/pull.yml",
        ".github/workflows/trunk.yml",
      ],
      "env_vars[CUDA_VISIBLE_DEVICES]": ["0,1", ""],
      ran_on: "pull_request,main",
      sort: "-failure_rate,-runs,cpu_architecture,-device_count,case_name",
      limit: "50",
    });
    expect(res.status).toBe(200);
    expect(listPage).toHaveBeenCalledWith({
      query: {
        repo: "pytorch/pytorch",
        search: "Test_case[a, b]",
        owner: ["autograd", "nn"],
        file: ["test/test_nn.py", "test/test_torch.py"],
        os: ["linux", "windows"],
        accelerator: ["cpu", "cuda"],
        device_count: [0],
        workflow_path: [
          ".github/workflows/pull.yml",
          ".github/workflows/trunk.yml",
        ],
        env_vars: { CUDA_VISIBLE_DEVICES: ["", "0,1"] },
        ran_on: ["main", "pull_request"],
        window: "12h",
        sort: [
          "-failure_rate",
          "-runs",
          "cpu_architecture",
          "-device_count",
          "case_name",
        ],
        limit: 50,
      },
      cursor: null,
    });
  });

  test("names the invalid filter and repeated-value index in a 400", async () => {
    const res = await getTests({ environments_id: ["1", "invalid"] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "environments_id.1: must be a UInt64 decimal string",
      code: "invalid_parameters",
      issues: [
        {
          path: ["environments_id", 1],
          message: "must be a UInt64 decimal string",
        },
      ],
    });
    expect(listPage).not.toHaveBeenCalled();
  });

  test("returns all collected parameter issues while preserving the first error message", async () => {
    const res = await getTests({ repo: "invalid", window: "2d", limit: "0" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "repo: repo must be owner/name",
      code: "invalid_parameters",
      issues: [
        { path: ["repo"], message: "repo must be owner/name" },
        {
          path: ["window"],
          message: "window must be one of: 3h, 12h, 1d, 3d, 7d, 14d",
        },
        {
          path: ["limit"],
          message: "limit must be an integer between 1 and 100",
        },
      ],
    });
    expect(listPage).not.toHaveBeenCalled();
  });

  test("preserves nested keys and numeric indexes in collected issues", async () => {
    const res = await getTests({
      environments_id: ["invalid", "also-invalid"],
      env_vars: JSON.stringify({ MODE: [1, false], "bad-key": ["value"] }),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_parameters");
    expect(
      res.body.issues.map((issue: { path: unknown[] }) => issue.path)
    ).toEqual([
      ["environments_id", 0],
      ["environments_id", 1],
      ["env_vars", "MODE", 0],
      ["env_vars", "MODE", 1],
      ["env_vars", "bad-key"],
    ]);
    for (const issue of res.body.issues) {
      expect(Object.keys(issue).sort()).toEqual(["message", "path"]);
      expect(issue.message).toEqual(expect.any(String));
    }
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(listPage).not.toHaveBeenCalled();
  });

  test("gives each unsupported parameter its own issue path", async () => {
    const res = await getTests({
      typo_one: "private-input",
      typo_two: "value",
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Unrecognized keys: "typo_one", "typo_two"',
      code: "invalid_parameters",
      issues: [
        { path: ["typo_one"], message: 'Unrecognized key: "typo_one"' },
        { path: ["typo_two"], message: 'Unrecognized key: "typo_two"' },
      ],
    });
    expect(listPage).not.toHaveBeenCalled();
  });

  test.each([
    {
      query: { env_vars: '{"SECRET":"private-input",', limit: "0" },
      path: ["env_vars"],
      message: "must be valid JSON",
    },
    {
      query: { search: ["private-input", "other"], limit: "0" },
      path: ["search"],
      message: "search must occur once",
    },
    {
      query: {
        env_vars: '{"SECRET":["private-input"]}',
        "env_vars[MODE]": "value",
        limit: "0",
      },
      path: ["env_vars"],
      message: "cannot combine JSON and bracket parameters",
    },
  ])(
    "returns the first decoding issue without its raw input: $message",
    async ({ query, path, message }) => {
      const res = await getTests(query);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: `${path[0]}: ${message}`,
        code: "invalid_parameters",
        issues: [{ path, message }],
      });
      expect(JSON.stringify(res.body)).not.toContain("private-input");
      expect(listPage).not.toHaveBeenCalled();
    }
  );

  test("binds cursor identity to the endpoint and all filters", async () => {
    for (const override of [
      { resource: "test-configurations" },
      { query: { ...baseCursor.query, owner: ["nn"] } },
      {
        query: {
          ...baseCursor.query,
          workflow_path: [".github/workflows/pull.yml"],
        },
      },
      {
        query: { ...baseCursor.query, env_vars: { TEST_CONFIG: ["default"] } },
      },
    ]) {
      const cursor = {
        ...baseCursor,
        ...override,
      };
      const res = await getTests({ cursor: encodeCursor(cursor as any) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(
        "resource" in override ? "invalid_cursor" : "cursor_query_mismatch"
      );
      expect(res.body).not.toHaveProperty("issues");
      expect(listPage).not.toHaveBeenCalled();
    }
  });

  test("answers 500 without exposing a database error", async () => {
    listPage.mockRejectedValue(new Error("private database connection failed"));
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const res = await getTests();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Failed to list tests",
      code: "internal_error",
    });
    expect(res.body.error).not.toContain("private database");
    expect(consoleError).toHaveBeenCalled();
  });
});
