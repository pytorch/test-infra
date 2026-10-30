import {
  canonicalValues,
  ParameterDefinition,
  parameterSchema,
  RawQuery,
} from "lib/api/parameters";
import {
  HealthWindow,
  PARAMETER_DEFINITIONS,
  RanOn,
  RanOnValuesSchema,
  uint64String,
  WindowSchema,
} from "lib/api/tests/parameters";
import { TestIdSchema } from "lib/api/tests/test/parameters";
import { z } from "zod/v4";

// The HUD pages built on the tests endpoints, defined where the endpoints
// are. Each page's URL query is a set of parameter definitions: the table
// page's are the list's own registry entries, picked by name, so the page
// takes a parameter exactly as GET /api/tests does; the test page's add the
// page's own. The pages read their URLs through these definitions
// (lib/tests/table.ts, lib/tests/grid.ts), the document describes them from
// the same objects (pages/openapi.ts) and the API writes its hud_url links
// with them (pages/links.ts), so the three cannot drift apart. Zod and the
// registry only, no handler and no database client: the pages import this
// module into the browser.

// ---------------------------------------------------------------------------
// Where the pages are
// ---------------------------------------------------------------------------

// The pages' paths as the document templates them. The repository is two
// segments, {organization}/{repo}, where the API takes one repo value.
export const TESTS_PAGE_PATH = "/tests/{organization}/{repo}";
export const TEST_PAGE_PATH = "/tests/{organization}/{repo}/test/{test_id}";

// The table page of a repository given as owner/name.
export function testsPagePath(repo: string): string {
  return `/tests/${repo
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

// The page of one test: the canonical page, with no parameters, the same
// from everywhere the test is named.
export function testPagePath(repo: string, testId: string): string {
  return `${testsPagePath(repo)}/test/${encodeURIComponent(testId)}`;
}

// Each half of the API's repo, owner/name, as a path segment.
const REPO_SEGMENT_ERROR = "must be one segment of an owner/name repository";
export const RepoSegmentSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, { error: REPO_SEGMENT_ERROR });

export const TESTS_PAGE_PATH_PARAMETERS = {
  organization: RepoSegmentSchema.describe(
    "The repository's owner, the part of GET /api/tests' repo before the slash: pytorch."
  ),
  repo: RepoSegmentSchema.describe(
    "The repository's name, the part of GET /api/tests' repo after the slash: pytorch."
  ),
};

export const TEST_PAGE_PATH_PARAMETERS = {
  ...TESTS_PAGE_PATH_PARAMETERS,
  test_id: TestIdSchema,
};

// ---------------------------------------------------------------------------
// The table page: GET /api/tests as a page
// ---------------------------------------------------------------------------

type ListParameterName = keyof typeof PARAMETER_DEFINITIONS;

// The list parameters the table page reads from its URL, in the order the
// document lists them: the name search and the exact name filters, which
// the Name header holds; the health status; the language; the environment
// fields, the test config, the workflow and the owner, which their columns'
// headers hold; then the title's code sources and window, and the sort. Each
// is the list's own definition, so the page spells, encodes and defaults it
// as the API does. A list parameter not named here is one the page has no
// equivalent for (TESTS_PAGE_UNSUPPORTED_PARAMETERS) or does not need
// (TESTS_PAGE_PAGING_PARAMETERS).
export const TESTS_PAGE_PARAMETER_NAMES = [
  "search",
  "file",
  "suite",
  "case_name",
  "declared_case_name",
  "status",
  "language",
  "accelerator",
  "accelerator_version",
  "device_name",
  "device_count",
  "python_version",
  "os",
  "os_version",
  "cpu_architecture",
  "cpu_capability",
  "cc_compiler",
  "cc_compiler_version",
  "test_config",
  "workflow_path",
  "owner",
  "ran_on",
  "window",
  "sort",
] as const satisfies readonly ListParameterName[];
export type TestsPageParameterName =
  (typeof TESTS_PAGE_PARAMETER_NAMES)[number];

export const TESTS_PAGE_PARAMETER_DEFINITIONS = Object.fromEntries(
  TESTS_PAGE_PARAMETER_NAMES.map((name) => [name, PARAMETER_DEFINITIONS[name]])
) as Pick<typeof PARAMETER_DEFINITIONS, TestsPageParameterName>;

export const TestsPageQuerySchema = parameterSchema(
  TESTS_PAGE_PARAMETER_DEFINITIONS
);
export type TestsPageQuery = z.infer<typeof TestsPageQuerySchema>;

// The list parameters that are not selection: the page pages by itself, so
// a link to it drops them.
export const TESTS_PAGE_PAGING_PARAMETERS = [
  "limit",
  "cursor",
] as const satisfies readonly ListParameterName[];

// The list parameters the table page has no equivalent for, computed as
// the complement so that a parameter added to the list is one of these
// until the page takes it up: environments_id and env_vars_id, the catalog
// ids, and env_vars, the filter on any variable, which the page shows only
// as test_config. A link to the page must not carry them; the page would
// ignore them and show more than the request selected.
export const TESTS_PAGE_UNSUPPORTED_PARAMETERS = (
  Object.keys(PARAMETER_DEFINITIONS) as ListParameterName[]
).filter(
  (name) =>
    name !== "repo" &&
    !(TESTS_PAGE_PARAMETER_NAMES as readonly string[]).includes(name) &&
    !(TESTS_PAGE_PAGING_PARAMETERS as readonly string[]).includes(name)
);

// The variable behind the list's test_config filter, which env_vars names
// in full: an env_vars filter on this variable alone is a test_config
// filter, and a link to the page spells it so.
export const TEST_CONFIG_VARIABLE = "TEST_CONFIG";

// ---------------------------------------------------------------------------
// The test page: one test's runs by commit, as a page
// ---------------------------------------------------------------------------

// How a cell of the grid reads: passed, flaky when a failing attempt was
// followed by a pass, failed for any failing final outcome, skipped when
// nothing executed, other for the expected failures, unexpected passes and
// unknowns. In the order the header's menu lists them, worst first.
export const GRID_OUTCOMES = [
  "failed",
  "flaky",
  "passed",
  "skipped",
  "other",
] as const;
export type GridOutcome = (typeof GRID_OUTCOMES)[number];

// What the page shows until the URL says otherwise: three days of main,
// long enough to see a test turn and short enough to keep one commit a
// column; every outcome, the time bar on, no commit sought, no
// configuration marked.
export const TEST_PAGE_DEFAULT_RAN_ON: readonly RanOn[] = ["main"];
export const TEST_PAGE_DEFAULT_WINDOW: HealthWindow = "3d";

const GRID_ENDPOINT = "GET /api/tests/test/{test_id}/runs?group_by=commit";

export const TEST_PAGE_PARAMETER_DEFINITIONS = {
  ran_on: {
    encoding: "csv",
    schema: RanOnValuesSchema.default([...TEST_PAGE_DEFAULT_RAN_ON])
      .transform(canonicalValues)
      .describe(
        `Code sources whose runs the grid shows, comma-separated or repeated, as ${GRID_ENDPOINT} defines them: main covers pushes and schedules on main; pull_request covers pull requests and ciflow tag pushes. main when absent.`
      ),
  },
  window: {
    encoding: "single",
    schema: WindowSchema.default(TEST_PAGE_DEFAULT_WINDOW).describe(
      `The window of the runs shown, as ${GRID_ENDPOINT} defines it: the jobs whose first attempt started within it, with every attempt of theirs. 3d when absent.`
    ),
  },
  outcomes: {
    encoding: "csv",
    schema: z
      .array(z.enum(GRID_OUTCOMES))
      .min(1)
      .default([...GRID_OUTCOMES])
      .describe(
        "Which cells are shown, comma-separated: failed, flaky (a failing attempt followed by a pass), passed, skipped, other (expected failures, unexpected passes and unknowns). The page narrows the grid itself and asks the API for every run. Every outcome when absent."
      ),
  },
  time_bar: {
    encoding: "single",
    schema: z
      .enum(["0", "1"])
      .default("1")
      .describe(
        "0 hides the time bar under each configuration's runs, which says how long the test takes and where that changed. Shown when absent, and never while pull requests are among the code sources."
      ),
  },
  commit: {
    encoding: "single",
    schema: z
      .string()
      .max(40)
      .optional()
      .describe(
        "A commit hash, or the start of one, to find among the columns: its column is banded and its pill pinned in the footer."
      ),
  },
  environment: {
    encoding: "single",
    schema: uint64String
      .optional()
      .describe(
        "With env_vars, the configuration to mark: the id of its environment, environment.id in the API's responses. The grid still shows every configuration; this one's lanes, one per workflow, are banded and scrolled into view. Both or neither."
      ),
  },
  env_vars: {
    encoding: "single",
    schema: uint64String
      .optional()
      .describe(
        "With environment, the id of the marked configuration's env var set, env_vars.id in the API's responses. An id, not the env_vars filter of the API."
      ),
  },
} as const satisfies Record<string, ParameterDefinition>;

export const TestPageQuerySchema = parameterSchema(
  TEST_PAGE_PARAMETER_DEFINITIONS
);
export type TestPageQuery = z.infer<typeof TestPageQuerySchema>;

// ---------------------------------------------------------------------------
// Reading and writing a page's URL
// ---------------------------------------------------------------------------

// A page's parameters as its URL carries them, decoded by each definition's
// encoding and not yet validated: a string for a single-valued parameter,
// the values for a comma-separated or repeated one.
export type PageQueryValues<
  Definitions extends Record<string, ParameterDefinition>
> = {
  -readonly [Name in keyof Definitions]?: Definitions[Name]["encoding"] extends "single"
    ? string
    : string[];
};

// Reads the given definitions' parameters out of a URL's query, by their
// encodings as parseParameters decodes a request: a comma-separated
// parameter is split and its parts trimmed, whether written once or
// repeated; a repeated parameter keeps each value as written; a
// single-valued parameter is its string, and is dropped when written
// twice. A name the definitions do not have is left alone, so a page
// ignores what it does not read, and nothing is validated here: a page
// checks a choice against the options, or a page-only value against its
// schema, and falls back to its default rather than failing.
export function decodePageQuery<
  Definitions extends Record<string, ParameterDefinition>
>(url: RawQuery, definitions: Definitions): PageQueryValues<Definitions> {
  const decoded: Record<string, string | string[]> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const raw = url[name];
    if (raw === undefined) continue;
    if (definition.encoding === "single") {
      if (typeof raw === "string") decoded[name] = raw;
    } else if (definition.encoding === "csv") {
      decoded[name] = [raw]
        .flat()
        .flatMap((value) => value.split(",").map((part) => part.trim()));
    } else if (definition.encoding === "repeat") {
      decoded[name] = [raw].flat();
    }
  }
  return decoded as PageQueryValues<Definitions>;
}

// What a definition's schema reads when the parameter is absent: its
// default, or undefined for a parameter without one.
function defaultOf(definition: ParameterDefinition): unknown {
  const parsed = definition.schema.safeParse(undefined);
  return parsed.success ? parsed.data : undefined;
}

function sameValues(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

// The URL parameters for a page's values: each spelled by its definition's
// encoding, a comma-separated parameter joined and a repeated one as an
// array, and left off (undefined) when it is absent, empty, or the
// definition's default, so a page URL carries only the choices made and a
// bare URL is the page's defaults. Next's router takes the result as a
// query; pageQueryString spells it for a link.
export function pageUrlParams<
  Definitions extends Record<string, ParameterDefinition>
>(
  values: PageQueryValues<Definitions>,
  definitions: Definitions
): { [_Name in keyof Definitions]: string | string[] | undefined } {
  const params: Record<string, string | string[] | undefined> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const value = (values as Record<string, string | string[] | undefined>)[
      name
    ];
    const fallback = defaultOf(definition);
    if (value === undefined || value === "" || value.length === 0) {
      params[name] = undefined;
    } else if (Array.isArray(value)) {
      const isDefault = Array.isArray(fallback) && sameValues(value, fallback);
      params[name] = isDefault
        ? undefined
        : definition.encoding === "csv"
        ? value.join(",")
        : value;
    } else {
      params[name] = value === fallback ? undefined : value;
    }
  }
  return params as {
    [_Name in keyof Definitions]: string | string[] | undefined;
  };
}

// The query string for a page's URL parameters, "?" included, or "" for
// none; a repeated parameter is written once per value.
export function pageQueryString(
  params: Record<string, string | string[] | undefined>
): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const each of [value].flat()) search.append(name, each);
  }
  const query = search.toString();
  return query === "" ? "" : `?${query}`;
}
