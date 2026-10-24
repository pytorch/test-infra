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
    pass_rate: 0.625,
    failure_rate: 0.25,
    flaky_rate: 0.125,
    skip_rate: 0.2,
    mean_passed_duration_milliseconds_combined: 1031,
    mean_duration_milliseconds_combined: 1340,
    total_duration_milliseconds_combined: 12060,
    last_run_at_combined: LAST_RUN_AT,
    last_failed_at_combined: "2026-10-19T10:00:00.000Z",
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
    sort_0: Date.parse(LAST_RUN_AT),
    sort_1: testId(index),
    sort_2: environmentsId,
    sort_3: envVarsId,
    ...overrides,
  };
}

export type QueryKind = "generation" | "tests";
const QUERY_IDS: Record<QueryKind, string> = {
  generation: "api_tests_generation",
  tests: "api_tests_page",
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
      Date.parse(LAST_RUN_AT),
      testId(1),
      "2081130751942693630",
      "1688593832548410197",
    ],
  },
};
