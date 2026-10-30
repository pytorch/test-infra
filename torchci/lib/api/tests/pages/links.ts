import {
  pageQueryString,
  PageQueryValues,
  pageUrlParams,
  TEST_CONFIG_VARIABLE,
  TEST_PAGE_PARAMETER_DEFINITIONS,
  testPagePath,
  TESTS_PAGE_PARAMETER_DEFINITIONS,
  TESTS_PAGE_PARAMETER_NAMES,
  TESTS_PAGE_UNSUPPORTED_PARAMETERS,
  testsPagePath,
} from "lib/api/tests/pages/parameters";
import {
  HealthWindow,
  RAN_ONS,
  RanOn,
  TestListQuery,
  WINDOWS,
} from "lib/api/tests/parameters";
import {
  RUN_FILTER_DEFINITIONS,
  RunsGridQuery,
} from "lib/api/tests/test/runs/parameters";
import type { TestHealthEntry } from "lib/api/tests/types";

// The hud_url links the tests endpoints answer with: the HUD page that shows
// what a response holds, written from the page definitions in
// pages/parameters.ts, so a link carries exactly the parameters the page
// reads, spelled as the page reads them, with the page's defaults left off.
// A link is absolute, so a caller can hand it to a person as it is.

export const DEFAULT_HUD_ORIGIN = "https://hud.pytorch.org";

// Where the pages are: this deployment, as the /api/authed/ shim names
// itself (HUD_SELF_URL), else production. Read when a link is written, so a
// test can set it.
export function hudOrigin(): string {
  return process.env.HUD_SELF_URL || DEFAULT_HUD_ORIGIN;
}

type TestPageValues = PageQueryValues<typeof TEST_PAGE_PARAMETER_DEFINITIONS>;
type TestsPageValues = PageQueryValues<typeof TESTS_PAGE_PARAMETER_DEFINITIONS>;

// A test's page, opened on the given choices; bare for none.
export function testPageUrl(
  repo: string,
  testId: string,
  values: TestPageValues = {}
): string {
  return `${hudOrigin()}${testPagePath(repo, testId)}${pageQueryString(
    pageUrlParams(values, TEST_PAGE_PARAMETER_DEFINITIONS)
  )}`;
}

// The test's page opened on the runs an entry's health was counted over,
// the requested window and code sources, with the entry's configuration
// marked when its catalog rows are known: what the list's Health and
// duration cells link to.
export function testPageLinkForEntry(
  entry: Pick<TestHealthEntry, "test" | "environment" | "env_vars">,
  query: { window: HealthWindow; ran_on: readonly RanOn[] }
): string {
  return testPageUrl(entry.test.repo, entry.test.id, {
    ran_on: [...query.ran_on],
    window: query.window,
    ...(entry.environment !== null && entry.env_vars !== null
      ? { environment: entry.environment.id, env_vars: entry.env_vars.id }
      : {}),
  });
}

// The table page showing a list request's selection: the request's
// parameters that the page reads, with the list's defaults left off, the
// repository in the path, and limit and cursor dropped, since the page pages
// by itself. An env_vars filter on TEST_CONFIG is the page's test_config;
// beside a test_config filter both must hold, so the page's test_config is
// the configurations the two share. Null when the request used a parameter
// the page has no equivalent for, the catalog ids or env_vars on another
// variable, and when the two TEST_CONFIG filters share nothing, since the
// request then selected nothing: the page would show more than the request
// selected, and a link that lies is worse than none.
export function testsPageLink(query: TestListQuery): string | null {
  const given = query as Record<string, unknown>;
  for (const name of TESTS_PAGE_UNSUPPORTED_PARAMETERS) {
    if (name !== "env_vars" && given[name] !== undefined) return null;
  }
  // The parsed values as the URL spells them: device_count's numbers are
  // decimal strings again.
  const values: Record<string, string | string[] | undefined> = {};
  for (const name of TESTS_PAGE_PARAMETER_NAMES) {
    const value = given[name];
    if (value === undefined) continue;
    values[name] = Array.isArray(value)
      ? value.map((each) => String(each))
      : String(value);
  }
  const variables = Object.keys(query.env_vars);
  if (variables.length > 0) {
    if (variables.length !== 1 || variables[0] !== TEST_CONFIG_VARIABLE) {
      return null;
    }
    const configurations = query.env_vars[TEST_CONFIG_VARIABLE];
    const shown =
      query.test_config === undefined
        ? configurations
        : configurations.filter((configuration) =>
            query.test_config?.includes(configuration)
          );
    if (shown.length === 0) return null;
    values.test_config = shown;
  }
  return `${hudOrigin()}${testsPagePath(query.repo)}${pageQueryString(
    pageUrlParams(values as TestsPageValues, TESTS_PAGE_PARAMETER_DEFINITIONS)
  )}`;
}

// The grid parameters that narrow the lanes in a way the page cannot show:
// the filters on the configuration, those on the environment and the env
// var set but the two ids, the env_vars filter and the workflow path. A
// filter on the test itself or its owner (file, suite, case_name,
// declared_case_name, language, owner) takes nothing from one test's grid:
// every lane shares the test, so it leaves the lanes as they are or empties
// the grid, which is null for want of a repository.
const GRID_NARROWING_PARAMETERS = [
  ...Object.entries(RUN_FILTER_DEFINITIONS).flatMap(([name, definition]) =>
    (definition.target === "environment" || definition.target === "env_vars") &&
    name !== "environments_id" &&
    name !== "env_vars_id"
      ? [name]
      : []
  ),
  "env_vars",
  "workflow_path",
];

// The test's page showing a grid request's runs: ran_on and window carried,
// each spelled as the widest choice when the request left it out (both code
// sources, which leaves out only the jobs that belong to neither; 14d, the
// retention), and one environments_id with one env_vars_id as the page's
// marked configuration, which the page shows among the others. Null without
// a repository, which the grid reads with its lanes and so lacks when it is
// empty, and null when the request narrowed the lanes in a way the page
// cannot show (GRID_NARROWING_PARAMETERS).
export function testPageLinkForGrid(
  repo: string | undefined,
  query: RunsGridQuery
): string | null {
  if (repo === undefined) return null;
  for (const name of GRID_NARROWING_PARAMETERS) {
    if ((query as Record<string, unknown>)[name] !== undefined) return null;
  }
  const environments = query.environments_id;
  const envVarSets = query.env_vars_id;
  if ((environments === undefined) !== (envVarSets === undefined)) return null;
  if (
    environments !== undefined &&
    envVarSets !== undefined &&
    (environments.length !== 1 || envVarSets.length !== 1)
  ) {
    return null;
  }
  return testPageUrl(repo, query.test_id, {
    ran_on: query.ran_on === undefined ? [...RAN_ONS] : [...query.ran_on],
    window: query.window ?? WINDOWS[WINDOWS.length - 1],
    ...(environments !== undefined && envVarSets !== undefined
      ? { environment: environments[0], env_vars: envVarSets[0] }
      : {}),
  });
}
