import { GET } from "app/api/tests/route";
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
      expect(listPage).not.toHaveBeenCalled();
    }
  );

  test("passes the centrally normalized request to the list implementation", async () => {
    const res = await getTests({
      search: "Test_case[a, b]",
      owner: ["module: nn", "module: autograd", "module: nn"],
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
        owner: ["module: autograd", "module: nn"],
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
        window: "7d",
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
    });
    expect(listPage).not.toHaveBeenCalled();
  });

  test("binds cursor identity to the endpoint and all filters", async () => {
    for (const override of [
      { resource: "test-configurations" },
      { query: { ...baseCursor.query, owner: ["module: nn"] } },
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
    expect(res.body.error).not.toContain("private database");
    expect(consoleError).toHaveBeenCalled();
  });
});
