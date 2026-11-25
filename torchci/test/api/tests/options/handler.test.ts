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
import {
  TEST_FIGURE_KINDS,
  TestOptionsSchema,
  TestView,
} from "lib/api/tests/options/types";
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
    // None runs in the heavy workload, where it would wait behind list
    // pages. The workflow paths, the one read of millions of rows, are kept
    // by the server's query cache; the catalogs are read each time.
    const settings = Object.fromEntries(
      queryClickhouse.mock.calls.map((call) => [call[2], call.slice(3, 5)])
    );
    expect(settings).toEqual({
      api_tests_options_environments: [],
      api_tests_options_env_vars: [],
      api_tests_options_owners: [],
      api_tests_options_workflow_paths: [true, { query_cache_ttl: 300 }],
    });
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

  test("offers views the list accepts, the first of them its defaults", async () => {
    const res = await get();
    const views: TestView[] = res.body.views;
    expect(views.length).toBeGreaterThan(1);
    const parse = (query: RawQuery) =>
      parseTestListParams({ repo: "pytorch/pytorch", ...query });
    expect(new Set(views.map((view) => view.id)).size).toBe(views.length);
    expect(new Set(views.map((view) => view.label)).size).toBe(views.length);
    for (const [index, view] of views.entries()) {
      for (const owned of ["repo", "limit", "cursor"]) {
        expect(view.params).not.toHaveProperty(owned);
      }
      expect(
        parseTestListParams({ repo: "pytorch/pytorch", ...view.params }).success
      ).toBe(true);
      // The page marks a view only while it shows exactly that view. It
      // opens on the list's defaults, which are the first view, the default
      // window included, so the page a reader arrives on has its cell
      // marked and the same table in another window has none; every other
      // view narrows or reorders the defaults, in whatever window the
      // reader is in, so two views are never marked for one table.
      if (index === 0) {
        expect(view.params.window).toBe(DEFAULT_WINDOW);
        expect(parse(view.params)).toEqual(parse({}));
      }
      for (const window of WINDOWS) {
        const asked = parse({ window, ...view.params });
        const defaults = parse({ window });
        if (index === 0) {
          // Its own window stands, whatever the page's.
          expect(asked).toEqual(parse({}));
          expect(asked.success && asked.data.window).toBe(DEFAULT_WINDOW);
        } else {
          expect(asked).not.toEqual(defaults);
        }
      }
      // Every value of a choice the options offer is one they offer, so the
      // page does not drop it; ran_on is comma-separated.
      for (const [name, raw] of Object.entries(view.params)) {
        if (!(name in res.body) || name === "views") continue;
        const offered = values(res.body[name]);
        const chosen = [raw]
          .flat()
          .flatMap((value) => (name === "ran_on" ? value.split(",") : value));
        for (const value of chosen) {
          expect(offered).toContain(value);
        }
      }
    }
  });

  // A figure is of the entries its view lists, or of some of them: its own
  // params may add filters, never another order, window, source or language,
  // so what it is of is always among what choosing the view shows.
  test("narrows a figure by filters alone, and only the defaults' to the unhealthy entries", async () => {
    const res = await get();
    const views: TestView[] = res.body.views;
    for (const view of views) {
      for (const kept of [
        "repo",
        "limit",
        "cursor",
        "sort",
        "window",
        "ran_on",
        "language",
      ]) {
        expect(view.figure.params).not.toHaveProperty(kept);
      }
      expect(
        parseTestListParams({
          repo: "pytorch/pytorch",
          ...view.params,
          ...view.figure.params,
        }).success
      ).toBe(true);
    }
    expect(
      Object.fromEntries(views.map((view) => [view.id, view.figure.params]))
    ).toEqual({
      unhealthy: { status: ["failing", "flaky"] },
      blocking_viable_strict: {},
      flaky_main: {},
      flaky_pull_requests: {},
      slowest: {},
      most_ci_time: {},
    });
    // The defaults order by status, worst first, so the unhealthy entries
    // the first figure counts, the failing and then the flaky, are the ones
    // its view's table begins with.
    expect(String(views[0].params.sort).split(",")[0]).toBe("-status");
    expect(
      res.body.status.values.map(({ value }: any) => value).slice(0, 2)
    ).toEqual(views[0].figure.params.status);
  });

  test("names the figure of every view, with a few words to set under it", async () => {
    const res = await get();
    const views: TestView[] = res.body.views;
    for (const view of views) {
      expect(TEST_FIGURE_KINDS).toContain(view.figure.kind);
      expect(view.figure.caption.trim()).toBe(view.figure.caption);
      expect(view.figure.caption.length).toBeGreaterThan(0);
      // Set under a figure in a narrow cell.
      expect(view.figure.caption.length).toBeLessThanOrEqual(28);
      // A view that sets its own window is read over it whatever window the
      // page is in, so its caption says which, as the options label it.
      if (view.params.window !== undefined) {
        const { label } = res.body.window.values.find(
          ({ value }: any) => value === view.params.window
        );
        expect(view.figure.caption.endsWith(`, ${label}`)).toBe(true);
      }
    }
    expect(
      Object.fromEntries(views.map((view) => [view.id, view.figure.kind]))
    ).toEqual({
      unhealthy: "count",
      blocking_viable_strict: "count",
      flaky_main: "count",
      flaky_pull_requests: "count",
      slowest: "slowest",
      most_ci_time: "total_duration",
    });
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
