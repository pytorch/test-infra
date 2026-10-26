import { GET } from "app/api/tests/options/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import {
  ENVIRONMENT_FACETS,
  ENVIRONMENT_VALUES_SQL,
  OWNER_VALUES_SQL,
  TEST_CONFIG_VALUES_SQL,
  WORKFLOW_PATH_VALUES_SQL,
} from "lib/api/tests/options/options";
import { TestOptionsSchema } from "lib/api/tests/options/types";
import {
  DEFAULT_RAN_ON,
  DEFAULT_WINDOW,
  HEALTH_STATUSES,
  LANGUAGES,
  parseTestListParams,
  RAN_ONS,
  WINDOWS,
} from "lib/api/tests/parameters";
import * as clickhouse from "lib/clickhouse";
import { callRoute } from "test/api/routes";
import {
  ENVIRONMENT_VALUES_ROW,
  OWNER_VALUES_ROW,
  TEST_CONFIG_VALUES_ROW,
  WORKFLOW_PATH_VALUES_ROW,
} from "../fixtures";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

function get(query: RawQuery = {}) {
  return callRoute(GET, "/api/tests/options", query);
}

const FIXED_CHOICES = ["window", "ran_on", "language", "status"] as const;
const CATALOG_CHOICES = [
  ...ENVIRONMENT_FACETS,
  "test_config",
  "workflow_path",
  "owner",
] as const;

type Choice = { default: string[]; values: { value: string; label: string }[] };
const values = (choice: Choice) => choice.values.map((option) => option.value);
const labels = (choice: Choice) => choice.values.map((option) => option.label);

describe("app/api/tests/options", () => {
  let queryClickhouse: jest.SpyInstance;

  beforeEach(() => {
    queryClickhouse = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockImplementation(async (sql: string) => {
        if (sql === ENVIRONMENT_VALUES_SQL) return [ENVIRONMENT_VALUES_ROW];
        if (sql === TEST_CONFIG_VALUES_SQL) return [TEST_CONFIG_VALUES_ROW];
        if (sql === WORKFLOW_PATH_VALUES_SQL) return [WORKFLOW_PATH_VALUES_ROW];
        if (sql === OWNER_VALUES_SQL) return [OWNER_VALUES_ROW];
        throw new Error(`Unexpected query: ${sql}`);
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("answers the list's accepted values, in order, with its defaults", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(TestOptionsSchema.parse(res.body)).toEqual(res.body);
    expect(values(res.body.window)).toEqual([...WINDOWS]);
    expect(values(res.body.ran_on)).toEqual([...RAN_ONS]);
    expect(values(res.body.language)).toEqual([...LANGUAGES]);
    expect(values(res.body.status)).toEqual([...HEALTH_STATUSES]);
    expect(labels(res.body.status)).toEqual([
      "failing",
      "flaky",
      "healthy",
      "skipped",
    ]);
    expect(res.body.window.default).toBe(DEFAULT_WINDOW);
    expect(res.body.ran_on.default).toEqual([...DEFAULT_RAN_ON]);
    expect(res.body.language.default).toEqual([]);
    expect(res.body.status.default).toEqual([]);
  });

  test("reads each source once and offers its distinct values in natural order", async () => {
    const res = await get();
    expect(queryClickhouse).toHaveBeenCalledTimes(4);
    expect(queryClickhouse.mock.calls.map(([, , id]) => id).sort()).toEqual([
      "api_tests_options_env_vars",
      "api_tests_options_environments",
      "api_tests_options_owners",
      "api_tests_options_workflow_paths",
    ]);
    expect(values(res.body.python_version)).toEqual([
      "3.9",
      "3.10",
      "3.11",
      "3.12",
      "3.14",
      "3.14t",
    ]);
    expect(values(res.body.accelerator_version)).toEqual([
      "",
      "10.1.0",
      "12.6",
      "13.2",
      "13.4",
    ]);
    expect(values(res.body.device_name)).toEqual([
      "",
      "AMD Instinct MI300X",
      "NVIDIA H100 80GB HBM3",
      "NVIDIA L4",
      "Tesla T4",
    ]);
    // Counts are numbers in the catalog and strings in a URL.
    expect(values(res.body.device_count)).toEqual(["0", "1", "2", "4", "8"]);
    expect(values(res.body.test_config)).toEqual([
      "default",
      "dynamo_wrapped",
      "inductor",
      "nogpu_AVX512",
      "slow",
    ]);
    expect(values(res.body.workflow_path)).toEqual([
      ".github/workflows/mac-mps.yml",
      ".github/workflows/pull.yml",
      ".github/workflows/rocm-mi300.yml",
      ".github/workflows/trunk.yml",
      "reusable/_linux-test.yaml",
    ]);
    // Labels as stored, alphabetically whatever their case or punctuation.
    expect(values(res.body.owner)).toEqual([
      "__torch_function__",
      "autograd",
      "core_tests",
      "linear algebra",
      "nn",
    ]);
    expect(labels(res.body.owner)).toEqual(values(res.body.owner));
    for (const choice of CATALOG_CHOICES) {
      expect(res.body[choice].default).toEqual([]);
    }
  });

  test("labels proper names as they are written, the rest as they are", async () => {
    const res = await get();
    expect(res.body.os.values).toEqual([
      { value: "linux", label: "Linux" },
      { value: "macos", label: "macOS" },
      { value: "windows", label: "Windows" },
    ]);
    expect(res.body.accelerator.values).toEqual([
      { value: "cpu", label: "CPU" },
      { value: "cuda", label: "CUDA" },
      { value: "mps", label: "MPS" },
      { value: "rocm", label: "ROCm" },
    ]);
    expect(labels(res.body.cc_compiler)).toEqual(["Clang", "GCC", "MSVC"]);
    expect(labels(res.body.cpu_capability)).toEqual(
      values(res.body.cpu_capability)
    );
    expect(labels(res.body.device_name)[0]).toBe("none");
    expect(labels(res.body.accelerator_version)[0]).toBe("none");
    expect(labels(res.body.test_config)).toEqual(values(res.body.test_config));
    // A workflow by its file; a path of another shape as it is.
    expect(labels(res.body.workflow_path)).toEqual([
      "mac-mps.yml",
      "pull.yml",
      "rocm-mi300.yml",
      "trunk.yml",
      "reusable/_linux-test.yaml",
    ]);
  });

  test("offers only values GET /api/tests accepts, and all of them", async () => {
    const res = await get();
    const accepts = (query: RawQuery) =>
      parseTestListParams({ repo: "pytorch/pytorch", ...query }).success;
    for (const choice of [...FIXED_CHOICES, ...CATALOG_CHOICES]) {
      for (const { value } of res.body[choice].values) {
        expect(accepts({ [choice]: value })).toBe(true);
      }
    }
    expect(accepts({ window: "2d" })).toBe(false);
    expect(accepts({ ran_on: "nightly" })).toBe(false);
    expect(accepts({ language: "rust" })).toBe(false);
    expect(accepts({ device_count: "256" })).toBe(false);
  });

  test("gives every value a distinct label for running text", async () => {
    const res = await get();
    for (const choice of [...FIXED_CHOICES, ...CATALOG_CHOICES]) {
      const choiceLabels: string[] = labels(res.body[choice]);
      expect(choiceLabels.every((label) => label.trim() === label)).toBe(true);
      expect(choiceLabels.every((label) => label.length > 0)).toBe(true);
      expect(new Set(choiceLabels).size).toBe(choiceLabels.length);
    }
    expect(res.body.window.values).toContainEqual({
      value: "7d",
      label: "7 days",
    });
    expect(res.body.ran_on.values).toContainEqual({
      value: "pull_request",
      label: "pull requests",
    });
    expect(res.body.language.values).toContainEqual({
      value: "cpp",
      label: "C++",
    });
  });

  test("offers no catalog values when the catalogs are empty", async () => {
    queryClickhouse.mockResolvedValue([]);
    const res = await get();
    expect(res.status).toBe(200);
    for (const choice of CATALOG_CHOICES) {
      expect(res.body[choice]).toEqual({ default: [], values: [] });
    }
    expect(values(res.body.window)).toEqual([...WINDOWS]);
  });

  test("answers 500 without details when a catalog cannot be read", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    queryClickhouse.mockRejectedValue(new Error("connection refused"));
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("internal_error");
    expect(res.body.error).not.toContain("connection refused");
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(error).toHaveBeenCalled();
  });

  test("may be kept briefly by the caller's browser, never by a shared cache", async () => {
    const res = await get();
    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=300, stale-while-revalidate=3600"
    );
    expect(res.headers.get("Vary")).toBe("Authorization, Cookie");
  });

  test.each([
    { repo: "pytorch/pytorch" },
    { window: "3h" },
    { ran_on: ["main"] },
    { language: "python" },
    { accelerator: "cuda" },
    { cursor: "anything" },
  ])("rejects any parameter without querying: %j", async (query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_parameters");
    expect(res.body.issues).toEqual([
      { path: [Object.keys(query)[0]], message: expect.any(String) },
    ]);
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(queryClickhouse).not.toHaveBeenCalled();
  });
});
