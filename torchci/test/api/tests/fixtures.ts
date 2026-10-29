import { GET } from "app/api/tests/route";
import type { RawQuery } from "lib/api/parameters";
import { TestListCursor } from "lib/api/tests/cursor";
import { DEFAULT_SORT, DEFAULT_WINDOW } from "lib/api/tests/parameters";
import { callRoute } from "test/api/routes";

export function getTests(query: RawQuery = {}) {
  return callRoute(GET, "/api/tests", { repo: "pytorch/pytorch", ...query });
}

// Above 2^53: ids must remain decimal strings throughout pagination.
export function testId(index: number) {
  return `1386292151555954${String(index).padStart(4, "0")}`;
}

export const REFRESHED_AT = "2026-10-19T17:45:00Z";
export const LAST_RUN_AT = "2026-10-19T16:28:13.575Z";
export const LAST_FAILED_AT = "2026-10-19T10:00:00.000Z";
// The mean passed duration of every entity row, the default sort's first key.
export const MEAN_PASSED_DURATION_MILLISECONDS = 1031;
export const UNSUPPORTED_ID_SORTS = [
  "test_id",
  "environments_id",
  "env_vars_id",
].flatMap((field) => [
  field,
  `-${field}`,
  `-last_run_at,${field}`,
  `-last_run_at,-${field}`,
]);
export const generationRows = [
  {
    refreshed_at: REFRESHED_AT,
  },
];

export function testRow(index: number, overrides: Record<string, any> = {}) {
  return {
    tests_id_string: testId(index),
    repo: "pytorch/pytorch",
    file: "test/test_torch.py",
    suite: "TestTorch",
    case_name: `test_case_${String(index).padStart(4, "0")}`,
    declared_case_name: "test_case",
    language: "python",
    first_seen_at: "2026-10-14T06:57:57.812Z",
    owners: ["core_tests"],
    has_health: 0,
    ...overrides,
  };
}

export function entityRow(
  index: number,
  environmentsId = "2081130751942693630",
  envVarsId = "1688593832548410197",
  overrides: Record<string, any> = {}
) {
  return {
    ...testRow(index),
    has_health: 1,
    environments_id_string: environmentsId,
    env_vars_id_string: envVarsId,
    runs_combined: 8,
    passed_runs_combined: 5,
    failed_runs_combined: 2,
    flaky_runs_combined: 1,
    skipped_runs_combined: 2,
    attempts_combined: 9,
    workflow_paths_combined: [],
    // Two of the eight runs failed and one of those passed on retry, so one
    // stayed failed: the status the SQL would derive from these counts.
    status: "failing",
    pass_rate: 0.625,
    failure_rate: 0.25,
    flaky_rate: 0.125,
    skip_rate: 0.2,
    mean_passed_duration_milliseconds_combined:
      MEAN_PASSED_DURATION_MILLISECONDS,
    mean_duration_milliseconds_combined: 1340,
    total_duration_milliseconds_combined: 12060,
    last_run_at_combined: LAST_RUN_AT,
    last_failed_at_combined: LAST_FAILED_AT,
    refreshed_at: REFRESHED_AT,
    environment_id_string: environmentsId,
    os: "linux",
    os_version: "22.04",
    cpu_architecture: "x86_64",
    cpu_capability: "avx2",
    python_version: "3.11",
    cc_compiler: "gcc",
    cc_compiler_version: "11",
    accelerator: "cuda",
    accelerator_version: "13.2",
    device_name: "NVIDIA L4",
    device_count: 1,
    environment_first_seen_at: "2026-10-13T19:31:24.819Z",
    env_var_set_id_string: envVarsId,
    env_vars: { TEST_CONFIG: "default" },
    env_vars_first_seen_at: "2026-10-13T19:03:23.252Z",
    // The default sort's keys for the row, as ClickHouse returns them: the
    // status rank (failing is 2), the failed runs and the mean are UInt64,
    // which come back as decimal strings, as the ids do; the rates are
    // Float64; the newest failure is its Unix milliseconds, a Float64.
    sort_0: "2",
    sort_1: 0.25,
    sort_2: "2",
    sort_3: Date.parse(LAST_FAILED_AT),
    sort_4: 0.2,
    sort_5: String(MEAN_PASSED_DURATION_MILLISECONDS),
    sort_6: testId(index),
    sort_7: environmentsId,
    sort_8: envVarsId,
    ...overrides,
  };
}

// The catalogs' distinct values as GET /api/tests/options reads them: one row
// of arrays per catalog. Chosen so that natural order differs from
// lexicographic order and every proper name and the empty value occur.
export const ENVIRONMENT_VALUES_ROW = {
  os: ["windows", "linux", "macos"],
  os_version: ["22.04", "10.0.17763", "26.3", "24.04"],
  cpu_architecture: ["x86_64", "aarch64"],
  cpu_capability: ["avx512", "avx2", "default", "amx", "sve256"],
  python_version: ["3.11", "3.9", "3.14t", "3.10", "3.14", "3.12"],
  cc_compiler: ["gcc", "msvc", "clang"],
  cc_compiler_version: ["11.4", "194234444", "13.4", "21.1.8"],
  accelerator: ["cuda", "cpu", "rocm", "mps"],
  accelerator_version: ["13.2", "", "10.1.0", "13.4", "12.6"],
  device_name: [
    "Tesla T4",
    "",
    "NVIDIA L4",
    "AMD Instinct MI300X",
    "NVIDIA H100 80GB HBM3",
  ],
  device_count: [4, 0, 1, 8, 2],
};
export const TEST_CONFIG_VALUES_ROW = {
  test_config: [
    "slow",
    "default",
    "inductor",
    "dynamo_wrapped",
    "nogpu_AVX512",
  ],
};
export const WORKFLOW_PATH_VALUES_ROW = {
  workflow_path: [
    ".github/workflows/trunk.yml",
    ".github/workflows/pull.yml",
    ".github/workflows/rocm-mi300.yml",
    ".github/workflows/mac-mps.yml",
    "reusable/_linux-test.yaml",
  ],
};
export const OWNER_VALUES_ROW = {
  owner: [
    "nn",
    "core_tests",
    "linear algebra",
    "autograd",
    "__torch_function__",
  ],
};
export const CATALOG_VALUES = {
  environments: ENVIRONMENT_VALUES_ROW,
  test_config: TEST_CONFIG_VALUES_ROW.test_config,
  workflow_path: WORKFLOW_PATH_VALUES_ROW.workflow_path,
  owner: OWNER_VALUES_ROW.owner,
};

export type QueryKind = "generation" | "tests" | "boundary";
const QUERY_IDS: Record<QueryKind, string> = {
  generation: "api_tests_generation",
  tests: "api_tests_page",
  boundary: "api_tests_page_boundary",
};

export function answerQueries(
  queryClickhouse: jest.SpyInstance,
  answers: Partial<Record<QueryKind, any[]>> = {}
) {
  const rows = { generation: generationRows, ...answers };
  queryClickhouse.mockImplementation(
    async (_sql: string, _params: unknown, queryId: string) => {
      const kind = (Object.keys(QUERY_IDS) as QueryKind[]).find(
        (key) => QUERY_IDS[key] === queryId
      );
      if (!kind) throw new Error(`Unexpected query: ${queryId}`);
      return rows[kind] ?? [];
    }
  );
}

export function callsOf(queryClickhouse: jest.SpyInstance, kind: QueryKind) {
  return queryClickhouse.mock.calls.filter(
    ([, , queryId]) => queryId === QUERY_IDS[kind]
  );
}

export const baseCursor: TestListCursor = {
  version: 1,
  resource: "tests",
  query: {
    repo: "pytorch/pytorch",
    window: DEFAULT_WINDOW,
    ran_on: ["main"],
    sort: [...DEFAULT_SORT],
    env_vars: {},
  },
  generation: REFRESHED_AT,
  position: {
    values: [
      "2",
      0.25,
      "2",
      Date.parse(LAST_FAILED_AT),
      0.2,
      String(MEAN_PASSED_DURATION_MILLISECONDS),
      testId(1),
      "2081130751942693630",
      "1688593832548410197",
    ],
  },
};
