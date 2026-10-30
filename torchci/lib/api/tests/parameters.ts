import {
  canonicalValues,
  ParameterDefinition,
  parameterQueryParameters,
  parameterSchema,
  parseParameters,
  RawQuery,
  sortSchema,
} from "lib/api/parameters";
import { z } from "zod/v4";

export { parseParameters } from "lib/api/parameters";
export type { ParameterDefinition } from "lib/api/parameters";

export const WINDOWS = ["3h", "12h", "1d", "3d", "7d", "14d"] as const;
export const RAN_ONS = ["main", "pull_request"] as const;
// The tests catalog's language enum, in menu order; unknown is its default.
export const LANGUAGES = ["python", "cpp", "unknown"] as const;
// How a configuration's runs went in the window, worst first: see
// HealthSummarySchema.status for the rules.
export const HEALTH_STATUSES = [
  "failing",
  "flaky",
  "healthy",
  "skipped",
] as const;
export type HealthWindow = (typeof WINDOWS)[number];
export type RanOn = (typeof RAN_ONS)[number];
export type TestLanguage = (typeof LANGUAGES)[number];
export type HealthStatus = (typeof HEALTH_STATUSES)[number];
export type SortOrder = "asc" | "desc";

// The last 12 hours: short enough to show what is failing now, long enough
// to cover the periodic workflows, which run every few hours.
export const DEFAULT_WINDOW: HealthWindow = "12h";
export const DEFAULT_RAN_ON: readonly RanOn[] = ["main"];
// Worst health first: the status, then the failure rate, the failed runs and
// the newest failure, then the skip rate and the passing mean, which only
// healthy rows reach. Skipped configurations, which have no rank, come last
// either way.
export const DEFAULT_SORT = [
  "-status",
  "-failure_rate",
  "-failed_runs",
  "-last_failed_at",
  "-skip_rate",
  "-mean_passed_duration_milliseconds",
] as const;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const MAX_SEARCH_LENGTH = 200;

const UINT64_MAX = BigInt("18446744073709551615");
function isUInt64(value: string): boolean {
  return /^\d{1,20}$/.test(value) && BigInt(value) <= UINT64_MAX;
}
export const uint64String = z
  .string()
  .refine(isUInt64, "must be a UInt64 decimal string")
  // This zod version still calls transforms after a failed refinement.
  .transform((value) => (isUInt64(value) ? BigInt(value).toString() : value));

// The record has no default: each endpoint chooses whether absence becomes an
// empty object or stays absent in its normalized query and cursor identity.
export const EnvVarsFilterSchema = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z.array(z.string()).min(1).transform(canonicalValues)
  )
  .transform((values) =>
    Object.fromEntries(
      Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    )
  );

const ENV_VARS_DESCRIPTION =
  'Require environment variables using one JSON object, for example env_vars={"TEST_CONFIG":["default","dynamo"]}, URL-encoded as a query parameter. Each name maps to a nonempty array: values for one name are ORed, and different names must all match the same configuration. Empty values, whitespace and commas are literal; a missing variable does not match an empty value. Legacy env_vars[NAME]=value parameters are also accepted, with repeated values for one name, but cannot be combined with the JSON parameter.';

interface FilterMetadata {
  target: "test" | "environment" | "env_vars" | "owner" | "health";
  column: string;
  type: "String" | "UInt64" | "UInt8";
  match?: "array";
  sortable?: false;
  sortExpression?: string;
}

export type FilterTarget = FilterMetadata["target"];

// The values of a repeatable exact-match filter: a nonempty set, deduplicated
// and sorted, optional as a whole.
export function exactValues<S extends z.ZodType<string | number>>(schema: S) {
  return z.array(schema).min(1).transform(canonicalValues).optional();
}

function exactFilter<S extends z.ZodType<string | number>>(
  schema: S,
  description: string,
  metadata: FilterMetadata
) {
  return {
    ...metadata,
    encoding: "repeat" as const,
    schema: exactValues(schema).describe(
      `${description} Exact, case-sensitive matching. Repeat this parameter to match any supplied value; commas and whitespace are literal.`
    ),
  };
}

function textFilter(
  column: string,
  target: FilterMetadata["target"],
  description: string
) {
  return exactFilter(z.string(), description, {
    target,
    column,
    type: "String",
  });
}

// These entries define the public filter names, validation, normalization,
// documentation and SQL bindings. The handler and query builder iterate this
// registry, so adding a filter here carries it through to cursor identity too.
export const FILTER_DEFINITIONS = {
  owner: exactFilter(
    z.string(),
    "Owner label as stored, without the module: prefix, for example nn or core_tests.",
    {
      target: "owner",
      column: "owners",
      type: "String",
      match: "array",
      sortExpression: "owner",
    }
  ),
  workflow_path: {
    ...textFilter(
      "workflow_paths_combined",
      "health",
      "Repository-relative calling workflow path, such as .github/workflows/slow.yml. Matches configurations observed on any supplied path within the selected window and code sources. Returned health counts and paths still cover all selected sources."
    ),
    match: "array",
    sortable: false,
  },
  // Read from the combined health like workflow_path; sorted through the
  // status rank in HEALTH_SORT_DEFINITIONS rather than by its name.
  status: {
    ...exactFilter(
      z.enum(HEALTH_STATUSES),
      "Health status of the configuration in the selected window and code sources, as health.status reports it: failing, flaky, healthy or skipped.",
      { target: "health", column: "status", type: "String" }
    ),
    sortable: false,
  },
  file: textFilter("file", "test", "Repository-relative test file or binary."),
  suite: textFilter("suite", "test", "Test class or suite; may be empty."),
  case_name: textFilter(
    "case_name",
    "test",
    "Runner-selected test name, including parameters."
  ),
  declared_case_name: textFilter(
    "declared_case_name",
    "test",
    "Test name as declared, before parameterization; may be empty."
  ),
  language: exactFilter(z.enum(LANGUAGES), "Test language.", {
    target: "test",
    column: "language",
    type: "String",
    sortExpression: "toString(language)",
  }),
  environments_id: exactFilter(
    uint64String,
    "Identity of the complete hardware and build environment.",
    {
      target: "environment",
      column: "id",
      type: "UInt64",
      sortExpression: "environments_id",
    }
  ),
  os: textFilter(
    "os",
    "environment",
    "Operating system, such as linux, macos or windows."
  ),
  os_version: textFilter(
    "os_version",
    "environment",
    "OS or container image version."
  ),
  cpu_architecture: textFilter(
    "cpu_architecture",
    "environment",
    "CPU architecture, such as x86_64 or aarch64."
  ),
  cpu_capability: textFilter(
    "cpu_capability",
    "environment",
    "CPU kernel capability, such as avx2 or avx512."
  ),
  python_version: textFilter(
    "python_version",
    "environment",
    "Python major.minor, optionally with a free-threaded t suffix."
  ),
  cc_compiler: textFilter(
    "cc_compiler",
    "environment",
    "Compiler that built torch, such as gcc, clang or msvc."
  ),
  cc_compiler_version: textFilter(
    "cc_compiler_version",
    "environment",
    "Version of the compiler that built torch."
  ),
  accelerator: textFilter(
    "accelerator",
    "environment",
    "Build accelerator: cpu, cuda, rocm, xpu or mps; cpu identifies a CPU build."
  ),
  accelerator_version: textFilter(
    "accelerator_version",
    "environment",
    "Accelerator stack version, such as 13.2 or 10.1.0; empty for cpu and mps builds."
  ),
  device_name: textFilter(
    "device_name",
    "environment",
    "Accelerator name as its vendor reports it, such as NVIDIA H100 80GB HBM3 or Tesla T4; may be empty without a GPU."
  ),
  device_count: exactFilter(
    z
      .union([
        z.number().int().nonnegative().max(255),
        z.string().regex(/^\d+$/),
      ])
      .transform(Number)
      .pipe(z.number().int().nonnegative().max(255)),
    "Number of visible accelerator devices, from 0 through 255.",
    { target: "environment", column: "device_count", type: "UInt8" }
  ),
  env_vars_id: exactFilter(
    uint64String,
    "Identity of a complete environment-variable set.",
    {
      target: "env_vars",
      column: "id",
      type: "UInt64",
      sortExpression: "env_vars_id",
    }
  ),
  // The one variable every set records, read out of the map so that it can
  // be offered, filtered and sorted like a column; env_vars still matches any
  // variable.
  test_config: textFilter(
    "env_vars['TEST_CONFIG']",
    "env_vars",
    "The env var set's TEST_CONFIG, the name the CI matrix gives the mode a test ran in, such as default, slow or inductor; empty for a set that does not record it. Equivalent to env_vars with that one variable, and sortable."
  ),
} as const;

export type FilterField = keyof typeof FILTER_DEFINITIONS;
// The parts of a test's name, in node id order, that search matches against.
export const SEARCH_FIELDS = [
  "file",
  "suite",
  "case_name",
] as const satisfies readonly FilterField[];

interface SortDefinition {
  expression: string;
  type: "String" | "Float64" | "UInt64";
}

const HEALTH_SORT_DEFINITIONS = {
  // The status as a rank, healthy 0, flaky 1, failing 2, so descending puts
  // the worst first; skipped has no rank and sorts last either way, like
  // the rates of a configuration without runs.
  status: { expression: "status_rank", type: "UInt64" },
  runs: { expression: "runs_combined", type: "UInt64" },
  passed_runs: { expression: "passed_runs_combined", type: "UInt64" },
  failed_runs: { expression: "failed_runs_combined", type: "UInt64" },
  flaky_runs: { expression: "flaky_runs_combined", type: "UInt64" },
  skipped_runs: { expression: "skipped_runs_combined", type: "UInt64" },
  attempts: { expression: "attempts_combined", type: "UInt64" },
  pass_rate: { expression: "pass_rate", type: "Float64" },
  failure_rate: { expression: "failure_rate", type: "Float64" },
  flaky_rate: { expression: "flaky_rate", type: "Float64" },
  skip_rate: { expression: "skip_rate", type: "Float64" },
  mean_passed_duration_milliseconds: {
    expression: "mean_passed_duration_milliseconds_combined",
    type: "UInt64",
  },
  mean_duration_milliseconds: {
    expression: "mean_duration_milliseconds_combined",
    type: "UInt64",
  },
  total_duration_milliseconds: {
    expression: "total_duration_milliseconds_combined",
    type: "UInt64",
  },
  last_run_at: {
    expression: "toUnixTimestamp64Milli(last_run_at_combined)",
    type: "Float64",
  },
  last_failed_at: {
    expression: "toUnixTimestamp64Milli(last_failed_at_combined)",
    type: "Float64",
  },
} as const;

// IDs provide deterministic pagination ties, but are not public sort choices.
export const IDENTITY_SORT_FIELDS = [
  "test_id",
  "environments_id",
  "env_vars_id",
] as const;

// Test IDs have no request filter, so their internal sort metadata lives here.
const SORT_ONLY_DEFINITIONS = {
  test_id: { expression: "tests_id", type: "UInt64" },
} as const;

export type HealthSortField = keyof typeof HEALTH_SORT_DEFINITIONS;
type SortableFilterField = {
  [Field in FilterField]: (typeof FILTER_DEFINITIONS)[Field] extends {
    sortable: false;
  }
    ? never
    : Field;
}[FilterField];
export type SortField =
  | SortableFilterField
  | HealthSortField
  | keyof typeof SORT_ONLY_DEFINITIONS;

// Sort metadata includes public fields and internal pagination identities.
export const SORT_DEFINITIONS = {
  ...SORT_ONLY_DEFINITIONS,
  ...Object.fromEntries(
    Object.entries(FILTER_DEFINITIONS)
      .filter(([, definition]) => definition.sortable !== false)
      .map(([name, definition]) => [
        name,
        {
          expression: definition.sortExpression ?? definition.column,
          type: definition.type === "String" ? "String" : "UInt64",
        },
      ])
  ),
  ...HEALTH_SORT_DEFINITIONS,
} as Record<SortField, SortDefinition>;

export const SORT_FIELDS = (
  Object.keys(SORT_DEFINITIONS) as SortField[]
).filter((field) => !IDENTITY_SORT_FIELDS.some((id) => id === field));
export const HEALTH_SORT_FIELDS = Object.keys(
  HEALTH_SORT_DEFINITIONS
) as HealthSortField[];

const RAN_ON_ERROR = `ran_on must be a comma-separated or repeated subset of: ${RAN_ONS.join(
  ", "
)}`;
const LIMIT_ERROR = `limit must be an integer between 1 and ${MAX_LIMIT}`;

// The values of ran_on and of window as every endpoint validates them,
// undecorated: the list adds its defaults below, the runs grouped by commit
// (test/runs/parameters.ts) their optionality.
export const RanOnValuesSchema = z
  .array(z.enum(RAN_ONS, { error: RAN_ON_ERROR }))
  .min(1, { error: RAN_ON_ERROR });
export const WindowSchema = z.enum(WINDOWS, {
  error: `window must be one of: ${WINDOWS.join(", ")}`,
});

export const PARAMETER_DEFINITIONS = {
  repo: {
    encoding: "single",
    schema: z
      .string({
        error: (issue) =>
          issue.input === undefined
            ? "Missing required param: repo"
            : "repo must be owner/name",
      })
      .regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/, {
        error: "repo must be owner/name",
      })
      .describe(
        "Required repository as owner/name, for example pytorch/pytorch."
      ),
  },
  search: {
    encoding: "single",
    schema: z
      .string()
      .max(MAX_SEARCH_LENGTH, {
        error: `search must be at most ${MAX_SEARCH_LENGTH} characters`,
      })
      .optional()
      .describe(
        `Text search over the test's name as pytest spells it, ${SEARCH_FIELDS.join(
          "::"
        )} with an empty suite left out: a test matches when the text occurs anywhere in it, ignoring ASCII case. Whitespace and commas are literal; an empty string matches every test.`
      ),
  },
  ...FILTER_DEFINITIONS,
  env_vars: {
    encoding: "json",
    legacyBracketValues: true,
    schema: EnvVarsFilterSchema.default({}).describe(ENV_VARS_DESCRIPTION),
  },
  ran_on: {
    encoding: "csv",
    schema: RanOnValuesSchema.default([...DEFAULT_RAN_ON])
      .transform(canonicalValues)
      .describe(
        "Code sources whose health to combine, comma-separated or repeated. main covers pushes and schedules on main; pull_request covers pull requests and ciflow tag pushes."
      ),
  },
  window: {
    encoding: "single",
    schema: WindowSchema.default(DEFAULT_WINDOW).describe(
      "Rolling health window ending at the queried health data's refresh time. Returns configurations observed in this window on the selected code sources."
    ),
  },
  sort: {
    encoding: "csv",
    schema: sortSchema(SORT_FIELDS, DEFAULT_SORT).describe(
      "Ordered, comma-separated sort fields. Prefix - for descending; otherwise ascending. Nulls always sort last. IDs are internal pagination tie-breakers and cannot be selected as sort fields. Owner ordering uses the alphabetically first owner label; unowned tests sort last. status orders healthy, flaky, failing, so -status puts the worst first; skipped configurations have no rank and sort last either way."
    ),
  },
  limit: {
    encoding: "single",
    schema: z.coerce
      .number({ error: LIMIT_ERROR })
      .int({ error: LIMIT_ERROR })
      .min(1, { error: LIMIT_ERROR })
      .max(MAX_LIMIT, { error: LIMIT_ERROR })
      .default(DEFAULT_LIMIT)
      .describe("Entries per page."),
  },
  cursor: {
    encoding: "single",
    schema: z
      .string()
      .optional()
      .describe(
        "Opaque pagination.next.cursor or pagination.previous.cursor from a returned page, valid only for the same query except page size. Cursors remain usable after health refreshes; pages reflect current data."
      ),
  },
} as const satisfies Record<string, ParameterDefinition>;

export const TestListParamsSchema = parameterSchema(PARAMETER_DEFINITIONS);
export const TestListQuerySchema = TestListParamsSchema.omit({ cursor: true });
export type TestListParams = z.infer<typeof TestListParamsSchema>;
export type TestListQuery = z.infer<typeof TestListQuerySchema>;

export function parseTestListParams(rawQuery: RawQuery) {
  return parseParameters(rawQuery, PARAMETER_DEFINITIONS, TestListParamsSchema);
}

export function getSortTerms(sort: readonly string[]) {
  return sort.map((value) => {
    const field = value.replace(/^-/, "") as SortField;
    if (!SORT_FIELDS.includes(field)) {
      throw new Error(`Unknown sort field: ${field}`);
    }
    const definition = SORT_DEFINITIONS[field];
    return {
      field,
      ...definition,
      direction: (value.startsWith("-") ? "desc" : "asc") as SortOrder,
    };
  });
}

// Parameter descriptions and serialization hints come from the same
// definitions that decode requests.
export function testListQueryParameters() {
  return parameterQueryParameters(TestListParamsSchema, PARAMETER_DEFINITIONS);
}
