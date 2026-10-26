import { CI_DATABASE } from "lib/api/tests/database";
import type { TestOptions } from "lib/api/tests/options/types";
import {
  DEFAULT_RAN_ON,
  DEFAULT_WINDOW,
  HEALTH_STATUSES,
  HealthStatus,
  HealthWindow,
  LANGUAGES,
  RAN_ONS,
  RanOn,
  TestLanguage,
  WINDOWS,
} from "lib/api/tests/parameters";
import { queryClickhouse } from "lib/clickhouse";
import { workflowName } from "lib/workflowName";

// How each value reads in running text, after "within the last", "on" and
// "in". Typed by the value sets, so a new value without a label does not
// compile.
const WINDOW_LABELS: Record<HealthWindow, string> = {
  "3h": "3 hours",
  "12h": "12 hours",
  "1d": "1 day",
  "3d": "3 days",
  "7d": "7 days",
  "14d": "14 days",
};
const RAN_ON_LABELS: Record<RanOn, string> = {
  main: "main",
  pull_request: "pull requests",
};
const LANGUAGE_LABELS: Record<TestLanguage, string> = {
  python: "Python",
  cpp: "C++",
  unknown: "Unknown",
};
const STATUS_LABELS: Record<HealthStatus, string> = {
  failing: "failing",
  flaky: "flaky",
  healthy: "healthy",
  skipped: "skipped",
};

function labelled<Value extends string>(
  values: readonly Value[],
  labels: Record<Value, string>
): { value: Value; label: string }[] {
  return values.map((value) => ({ value, label: labels[value] }));
}

// The environment fields a reader filters on, each a column of the
// environments catalog and a parameter of GET /api/tests of the same name.
export const ENVIRONMENT_FACETS = [
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
] as const;
export type EnvironmentFacet = (typeof ENVIRONMENT_FACETS)[number];

// The catalogs' distinct values, as the queries below return them: strings
// but for device_count, which is a number in the catalog; the workflow
// paths the health table has seen; and the owner labels of the owners
// catalog.
export interface CatalogValues {
  environments: Record<EnvironmentFacet, readonly (string | number)[]>;
  test_config: readonly string[];
  workflow_path: readonly string[];
  owner: readonly string[];
}

// The facets whose values are read from the database rather than fixed by
// the code.
export type CatalogFacet =
  | EnvironmentFacet
  | "test_config"
  | "workflow_path"
  | "owner";

// The proper names the catalogs spell in lowercase. Every other value, a
// version, an architecture, a device name as its vendor reports it, is its
// own label.
const PROPER_NAMES: Partial<Record<EnvironmentFacet, Record<string, string>>> =
  {
    os: { linux: "Linux", macos: "macOS", windows: "Windows" },
    accelerator: {
      cpu: "CPU",
      cuda: "CUDA",
      rocm: "ROCm",
      xpu: "XPU",
      mps: "MPS",
    },
    cc_compiler: { gcc: "GCC", clang: "Clang", msvc: "MSVC" },
  };
export const EMPTY_VALUE_LABEL = "none";

// Natural order: "3.9" before "3.10", "10.1.0" before "12.6", names
// alphabetically whatever their case, the empty value first.
const naturalOrder = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

// A workflow is labelled by its file, as the tests page names it
// (workflowName): .github/workflows/pull.yml is "pull.yml".
export function catalogLabel(facet: CatalogFacet, value: string): string {
  if (value === "") return EMPTY_VALUE_LABEL;
  if (facet === "test_config" || facet === "owner") return value;
  if (facet === "workflow_path") return workflowName(value);
  return PROPER_NAMES[facet]?.[value] ?? value;
}

function catalogChoice(
  facet: CatalogFacet,
  values: readonly (string | number)[]
) {
  const distinct = Array.from(new Set(values.map(String))).sort((a, b) =>
    naturalOrder.compare(a, b)
  );
  return {
    default: [],
    values: distinct.map((value) => ({
      value,
      label: catalogLabel(facet, value),
    })),
  };
}

// The options for the given catalog values: the fixed choices from the
// list's parameter definitions, the open ones from the catalogs.
export function testOptionsFrom(catalog: CatalogValues): TestOptions {
  return {
    window: {
      default: DEFAULT_WINDOW,
      values: labelled(WINDOWS, WINDOW_LABELS),
    },
    ran_on: {
      default: [...DEFAULT_RAN_ON],
      values: labelled(RAN_ONS, RAN_ON_LABELS),
    },
    language: {
      default: [],
      values: labelled(LANGUAGES, LANGUAGE_LABELS),
    },
    status: {
      default: [],
      values: labelled(HEALTH_STATUSES, STATUS_LABELS),
    },
    ...(Object.fromEntries(
      ENVIRONMENT_FACETS.map((facet) => [
        facet,
        catalogChoice(facet, catalog.environments[facet]),
      ])
    ) as Record<EnvironmentFacet, ReturnType<typeof catalogChoice>>),
    test_config: catalogChoice("test_config", catalog.test_config),
    workflow_path: catalogChoice("workflow_path", catalog.workflow_path),
    owner: catalogChoice("owner", catalog.owner),
  };
}

// One row of arrays, a distinct set per field. Rows of the catalogs that
// share an id are identical in these columns, the id being their hash, so the
// sets need no FINAL. groupUniqArray returns the sets in no particular order;
// testOptionsFrom sorts them.
export const ENVIRONMENT_VALUES_SQL = `
SELECT
    ${ENVIRONMENT_FACETS.map(
      (facet) => `groupUniqArray(${facet}) AS ${facet}`
    ).join(",\n    ")}
FROM ${CI_DATABASE}.environments
`;
export const TEST_CONFIG_VALUES_SQL = `
SELECT groupUniqArray(env_vars['TEST_CONFIG']) AS test_config
FROM ${CI_DATABASE}.env_vars
`;
// Every calling workflow path the health table has seen in its longest
// window, on either code source: what the list's workflow_path filter can
// match. The two 14d partitions hold some 30 million short arrays; reading
// them takes about 0.2 s.
export const WORKFLOW_PATH_VALUES_SQL = `
SELECT groupUniqArrayArray(workflow_paths) AS workflow_path
FROM ${CI_DATABASE}.health
WHERE window = '14d'
`;
// Every owner label of the owners catalog, read with FINAL because a file's
// row is replaced whole when its owners change and the old labels must not
// be offered. Some two thousand rows.
export const OWNER_VALUES_SQL = `
SELECT groupUniqArrayArray(owners) AS owner
FROM ${CI_DATABASE}.owners FINAL
`;

export async function readCatalogValues(): Promise<CatalogValues> {
  const [environmentRows, testConfigRows, workflowPathRows, ownerRows] =
    await Promise.all([
      queryClickhouse(
        ENVIRONMENT_VALUES_SQL,
        {},
        "api_tests_options_environments"
      ),
      queryClickhouse(TEST_CONFIG_VALUES_SQL, {}, "api_tests_options_env_vars"),
      queryClickhouse(
        WORKFLOW_PATH_VALUES_SQL,
        {},
        "api_tests_options_workflow_paths"
      ),
      queryClickhouse(OWNER_VALUES_SQL, {}, "api_tests_options_owners"),
    ]);
  const environments = Object.fromEntries(
    ENVIRONMENT_FACETS.map((facet) => [
      facet,
      (environmentRows[0]?.[facet] ?? []) as (string | number)[],
    ])
  ) as unknown as CatalogValues["environments"];
  return {
    environments,
    test_config: (testConfigRows[0]?.test_config ?? []) as string[],
    workflow_path: (workflowPathRows[0]?.workflow_path ?? []) as string[],
    owner: (ownerRows[0]?.owner ?? []) as string[],
  };
}

// The options as the endpoint answers them: read from the list's parameter
// definitions, from the catalogs and from the health table.
export async function testOptions(): Promise<TestOptions> {
  return testOptionsFrom(await readCatalogValues());
}
