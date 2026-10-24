import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parseTestListParams,
} from "lib/api/tests/parameters";
import {
  parseRunsListParams,
  RUN_CATALOG_SORT_FIELDS,
  RUN_SORT_FIELDS,
  RunsListQuery,
} from "lib/api/tests/test/runs/parameters";
import { RUN_OUTCOMES } from "./fixtures";

const TEST_ID = "18446744073709551615";

function parse(raw: Record<string, string | string[] | undefined> = {}) {
  const result = parseRunsListParams({ test_id: TEST_ID, ...raw });
  if (!result.success) throw result.error;
  return result.data;
}

describe("test runs parameters", () => {
  test("defaults to all configurations, all outcomes and descending start time", () => {
    expect(parse()).toEqual({
      test_id: TEST_ID,
      sort: ["-started_at"],
      limit: DEFAULT_LIMIT,
    });
  });

  test.each(RUN_OUTCOMES)("accepts the recorded outcome %s", (outcome) => {
    expect(parse({ outcome }).outcome).toEqual([outcome]);
  });

  test("normalizes repeated outcomes to a sorted set", () => {
    expect(parse({ outcome: ["failed", "error", "failed"] }).outcome).toEqual([
      "error",
      "failed",
    ]);
  });

  test("shares catalog matching and normalization with the test listing", () => {
    const filters = {
      search: " name, with spaces ",
      owner: ["module: nn", "module: autograd", "module: nn"],
      file: ["test/test_torch.py", "test/test_ops.py"],
      suite: ["", "TestClass"],
      case_name: "test_name[a, b]",
      declared_case_name: " test_name ",
      language: ["python", "cpp", "python"],
      os: ["windows", "linux"],
      os_version: "Ubuntu 22.04",
      cpu_architecture: "x86_64",
      cpu_capability: "avx2",
      python_version: "3.13t",
      cc_compiler: "gcc",
      cc_compiler_version: "12.3",
      accelerator: "cuda",
      accelerator_version: "12.8",
      device_name: "NVIDIA A100",
      device_count: ["8", "02", "2", "0"],
      environments_id: ["0002", "1", "2"],
      env_vars_id: ["0009", "8"],
      "env_vars[Z_LAST]": ["b", "a", "b"],
      "env_vars[A_FIRST]": ["", " a,b "],
    };
    const listing = parseTestListParams({
      repo: "pytorch/pytorch",
      ...filters,
    });
    if (!listing.success) throw listing.error;
    const {
      repo: _repo,
      ran_on: _ranOn,
      window: _window,
      sort: _sort,
      ...catalog
    } = listing.data;
    expect(parse(filters)).toEqual({
      test_id: TEST_ID,
      sort: ["-started_at"],
      ...catalog,
    });
    expect(parse(filters)).toMatchObject({
      case_name: ["test_name[a, b]"],
      declared_case_name: [" test_name "],
      device_count: [0, 2, 8],
      env_vars: { A_FIRST: ["", " a,b "], Z_LAST: ["a", "b"] },
    });
  });

  test("normalizes workflow paths and numeric execution filters", () => {
    expect(
      parse({
        workflow_path: [
          ".github/workflows/trunk.yml",
          " a,b ",
          ".github/workflows/trunk.yml",
        ],
        rerun_number: ["65535", "02", "2", "0"],
      })
    ).toMatchObject({
      workflow_path: [" a,b ", ".github/workflows/trunk.yml"],
      rerun_number: [0, 2, 65535],
    });
  });

  test.each(RUN_SORT_FIELDS)(
    "accepts ascending and descending %s sorting",
    (field) => {
      expect(parse({ sort: field }).sort).toEqual([field]);
      expect(parse({ sort: `-${field}` }).sort).toEqual([`-${field}`]);
    }
  );

  test("preserves mixed catalog and run sorting priorities", () => {
    expect(
      parse({ sort: "-owner, file,-device_count,outcome,-rerun_number" }).sort
    ).toEqual(["-owner", "file", "-device_count", "outcome", "-rerun_number"]);
    expect(RUN_CATALOG_SORT_FIELDS).toEqual(
      expect.arrayContaining([
        "file",
        "suite",
        "case_name",
        "declared_case_name",
        "language",
        "owner",
        "os",
        "os_version",
        "cpu_architecture",
        "cpu_capability",
        "python_version",
        "cc_compiler",
        "cc_compiler_version",
        "accelerator",
        "accelerator_version",
        "device_name",
        "device_count",
      ])
    );
  });

  test("canonicalizes UInt64 IDs without losing precision", () => {
    expect(
      parse({
        test_id: "000123",
        environments_id: ["9007199254740993", "0002", "2", TEST_ID],
        env_vars_id: ["0009", "8", "9"],
      })
    ).toMatchObject({
      test_id: "123",
      environments_id: [TEST_ID, "2", "9007199254740993"],
      env_vars_id: ["8", "9"],
    });
    expect(parse({ test_id: "0", environments_id: "0" })).toMatchObject({
      test_id: "0",
      environments_id: ["0"],
    });
  });

  test.each([
    ["started_at", ["started_at"]],
    ["-started_at", ["-started_at"]],
    ["ended_at", ["ended_at"]],
    ["-ended_at", ["-ended_at"]],
    ["-ended_at, started_at", ["-ended_at", "started_at"]],
    [
      ["ended_at", "-started_at"],
      ["ended_at", "-started_at"],
    ],
  ])("accepts ordered timestamp sorts %j", (sort, expected) => {
    expect(parse({ sort }).sort).toEqual(expected);
  });

  test("every query option retains its value for cursor identity", () => {
    const parsed = parse({
      environments_id: ["2", "1"],
      env_vars_id: "3",
      outcome: ["failed", "error"],
      owner: ["module: nn", "module: nn"],
      workflow_path: ".github/workflows/trunk.yml",
      rerun_number: "01",
      "env_vars[MODE]": "test",
      sort: "ended_at,-started_at",
      limit: String(MAX_LIMIT),
      cursor: "opaque-cursor",
    });
    const { cursor, ...query } = parsed;
    const expected: RunsListQuery = {
      test_id: TEST_ID,
      environments_id: ["1", "2"],
      env_vars_id: ["3"],
      outcome: ["error", "failed"],
      owner: ["module: nn"],
      workflow_path: [".github/workflows/trunk.yml"],
      rerun_number: [1],
      env_vars: { MODE: ["test"] },
      sort: ["ended_at", "-started_at"],
      limit: MAX_LIMIT,
    };
    expect(query).toEqual(expected);
    expect(cursor).toBe("opaque-cursor");
  });

  test.each([
    { test_id: undefined },
    { test_id: "" },
    { test_id: "-1" },
    { test_id: "1.5" },
    { test_id: "1e3" },
    { test_id: " 123" },
    { test_id: "123 " },
    { test_id: "0x123" },
    { test_id: "18446744073709551616" },
    { test_id: "1' OR 1 = 1" },
    { test_id: ["123"] },
    { test_id: ["123", "456"] },
    { environments_id: "18446744073709551616" },
    { environments_id: "-1" },
    { environments_id: "1,2" },
    { environments_id: ["1", " 2"] },
    { environments_id: [] },
    { env_vars_id: "invalid" },
    { env_vars_id: "1,2" },
    { env_vars_id: [] },
    { environment_id: "1" },
    { repo: "pytorch/pytorch" },
    { ran_on: "main" },
    { window: "7d" },
    { outcome: "success" },
    { outcome: "FAILED" },
    { outcome: "Failed" },
    { outcome: "failed,error" },
    { outcome: " failed" },
    { outcome: "failed " },
    { outcome: "" },
    { outcome: [] },
    { outcome: ["failed", "invalid"] },
    { outcome: ["failed", ""] },
    { outcome: "failed') OR 1=1 --" },
    { language: "Python" },
    { language: "rust" },
    { owner: [] },
    { file: [] },
    { workflow_path: [] },
    { device_count: "256" },
    { device_count: "-1" },
    { device_count: "1.0" },
    { rerun_number: "65536" },
    { rerun_number: "-1" },
    { rerun_number: "1.5" },
    { rerun_number: "1e2" },
    { rerun_number: " 1" },
    { rerun_number: "1,2" },
    { rerun_number: "" },
    { rerun_number: [] },
    { search: "x".repeat(201) },
    { search: ["a", "b"] },
    { env_vars: "MODE=test" },
    { "env_vars[MODE]": [] },
    { "env_vars[bad-name]": "value" },
    { "env_vars[__proto__]": "value" },
    { env_vars: "", "env_vars[MODE]": "test" },
    { sort: "" },
    { sort: "started_at,-started_at" },
    { sort: "ended_at,ended_at" },
    { sort: "started_at,,ended_at" },
    { sort: "-runs" },
    { sort: "test_id" },
    { sort: "-report_uuid" },
    { sort: "environments_id" },
    { sort: "env_vars_id" },
    { sort: "search" },
    { sort: "env_vars" },
    { sort: "owner,-owner" },
    { sort: "workflow_path,workflow_path" },
    { order: "asc" },
    { limit: "0" },
    { limit: "2.5" },
    { limit: String(MAX_LIMIT + 1) },
    { limit: ["25"] },
    { cursor: ["one", "two"] },
    { unknown: "value" },
  ])("rejects malformed or unsupported parameters %j", (raw) => {
    expect(parseRunsListParams({ test_id: TEST_ID, ...raw }).success).toBe(
      false
    );
  });
});
