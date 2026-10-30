import {
  canonicalValues,
  parameterQueryParameters,
  parameterSchema,
  parseParameters,
  RawQuery,
  sortSchema,
} from "lib/api/parameters";
import { pathParameter } from "lib/api/schema";
import {
  EnvVarsFilterSchema,
  exactValues,
  FILTER_DEFINITIONS,
  PARAMETER_DEFINITIONS,
  RanOnValuesSchema,
  WindowSchema,
} from "lib/api/tests/parameters";
import { TestIdSchema } from "lib/api/tests/test/parameters";
import {
  RunOutcomeSchema,
  RunRerunNumberSchema,
} from "lib/api/tests/test/runs/types";
import { z } from "zod/v4";

// Reuse the test listing's exact catalog filters. Health-window filters do not
// apply to run bundles.
export const RUN_FILTER_DEFINITIONS = {
  owner: FILTER_DEFINITIONS.owner,
  file: FILTER_DEFINITIONS.file,
  suite: FILTER_DEFINITIONS.suite,
  case_name: FILTER_DEFINITIONS.case_name,
  declared_case_name: FILTER_DEFINITIONS.declared_case_name,
  language: FILTER_DEFINITIONS.language,
  environments_id: FILTER_DEFINITIONS.environments_id,
  os: FILTER_DEFINITIONS.os,
  os_version: FILTER_DEFINITIONS.os_version,
  cpu_architecture: FILTER_DEFINITIONS.cpu_architecture,
  cpu_capability: FILTER_DEFINITIONS.cpu_capability,
  python_version: FILTER_DEFINITIONS.python_version,
  cc_compiler: FILTER_DEFINITIONS.cc_compiler,
  cc_compiler_version: FILTER_DEFINITIONS.cc_compiler_version,
  accelerator: FILTER_DEFINITIONS.accelerator,
  accelerator_version: FILTER_DEFINITIONS.accelerator_version,
  device_name: FILTER_DEFINITIONS.device_name,
  device_count: FILTER_DEFINITIONS.device_count,
  env_vars_id: FILTER_DEFINITIONS.env_vars_id,
} as const;

type CatalogFilterField = keyof typeof RUN_FILTER_DEFINITIONS;
export const RUN_CATALOG_SORT_FIELDS = (
  Object.keys(RUN_FILTER_DEFINITIONS) as CatalogFilterField[]
).filter(
  (
    field
  ): field is Exclude<CatalogFilterField, "environments_id" | "env_vars_id"> =>
    field !== "environments_id" && field !== "env_vars_id"
);
export const RUN_SORT_FIELDS = [
  "started_at",
  "ended_at",
  "outcome",
  "rerun_number",
  ...RUN_CATALOG_SORT_FIELDS,
  "workflow_path",
] as const;
export const DEFAULT_RUN_SORT = ["-started_at"] as const;

export const RUN_LIST_PARAMETER_DEFINITIONS = {
  search: PARAMETER_DEFINITIONS.search,
  ...RUN_FILTER_DEFINITIONS,
  env_vars: {
    ...PARAMETER_DEFINITIONS.env_vars,
    // Preserve the distinction between an omitted filter and a supplied one.
    schema: EnvVarsFilterSchema.optional().describe(
      PARAMETER_DEFINITIONS.env_vars.schema.description!
    ),
  },
  workflow_path: {
    encoding: "repeat",
    schema: exactValues(z.string()).describe(
      "Repository-relative calling workflow path, such as .github/workflows/slow.yml, from the latest retained workflow run metadata. Exact, case-sensitive matching. Repeat this parameter to match any supplied value; commas and whitespace are literal. Runs without a known path do not match."
    ),
  },
  outcome: {
    encoding: "repeat",
    schema: z
      .array(RunOutcomeSchema)
      .min(1)
      .transform(canonicalValues)
      .optional()
      .describe(
        "Select bundles containing an attempt with this recorded outcome after replacement deduplication. Repeat this parameter to match any supplied outcome; matching is exact and case-sensitive. When rerun_number is also supplied, both filters must match the same attempt. Every attempt in a matching bundle is returned. Omit to include all outcomes."
      ),
  },
  last_attempt_outcome: {
    encoding: "repeat",
    schema: z
      .array(RunOutcomeSchema)
      .min(1)
      .transform(canonicalValues)
      .optional()
      .describe(
        "Select bundles whose last retained attempt has this recorded outcome after replacement deduplication. The last attempt is the greatest (started_at, ended_at, id) tuple, using the execution UUID string for id. Repeat this parameter to match any supplied outcome; matching is exact and case-sensitive. Evaluated independently of outcome and rerun_number, which may match a different attempt. Filtering happens before pagination, and every attempt in a matching bundle is returned. The last retained attempt does not imply a completed retry chain. Omit to include all outcomes."
      ),
  },
  rerun_number: {
    encoding: "repeat",
    schema: z
      .array(
        z
          .union([RunRerunNumberSchema, z.string().regex(/^\d+$/)])
          .transform(Number)
          .pipe(RunRerunNumberSchema)
      )
      .min(1)
      .transform(canonicalValues)
      .optional()
      .describe(
        "Select bundles containing an attempt with this zero-based execution number within its report, from 0 through 65535, independent of the GitHub job attempt. Repeat this parameter to match any supplied number. When outcome is also supplied, both filters must match the same attempt. Every attempt in a matching bundle is returned. The counter resets in each report; a positive value does not imply that a previous execution failed. See the response field for how this counter is determined."
      ),
  },
  sort: {
    encoding: "csv",
    schema: sortSchema(RUN_SORT_FIELDS, DEFAULT_RUN_SORT).describe(
      "Ordered, comma-separated bundle sort fields. Prefix - for descending; otherwise ascending. started_at uses the earliest attempt start and ended_at the latest attempt end. outcome and rerun_number use the last attempt in chronological order (started_at, ended_at, id), including attempts that do not match filters. Defaults to newest bundle started_at first. Nulls always sort last. Owner ordering uses the alphabetically first owner label; unowned tests sort last. Text and outcome ordering is lexicographic; device_count and rerun_number ordering is numeric. Bundle identity fields break ties internally; IDs cannot be selected."
    ),
  },
  limit: {
    ...PARAMETER_DEFINITIONS.limit,
    schema: PARAMETER_DEFINITIONS.limit.schema.describe(
      "Bundles per page. Every attempt in a selected bundle is returned, so a bundle is never split across pages."
    ),
  },
  cursor: {
    ...PARAMETER_DEFINITIONS.cursor,
    schema: PARAMETER_DEFINITIONS.cursor.schema.describe(
      "Opaque pagination.next.cursor or pagination.previous.cursor from a returned page. Repeat the same endpoint and selection (test ID or repository and commit SHA), filters and ordering; page size may change. Pages read current data rather than a fixed snapshot. Cursors issued before attempt bundling are rejected with 400."
    ),
  },
} as const;

const TEST_ID_DEFINITION = {
  test_id: { encoding: "single", schema: TestIdSchema },
} as const;

const RUNS_LIST_PARAMETER_DEFINITIONS = {
  ...TEST_ID_DEFINITION,
  ...RUN_LIST_PARAMETER_DEFINITIONS,
} as const;

export const RunsListParamsSchema = parameterSchema(
  RUNS_LIST_PARAMETER_DEFINITIONS
);
export const RunsListQuerySchema = RunsListParamsSchema.omit({ cursor: true });
export type RunsListQuery = z.infer<typeof RunsListQuerySchema>;

export function parseRunsListParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    RUNS_LIST_PARAMETER_DEFINITIONS,
    RunsListParamsSchema
  );
}

// The runs grouped by commit, for a grid of a test's history: the same
// endpoint with group_by=commit, where every bundle filter that selects a
// configuration or a workflow still applies, and the parameters of a page of
// bundles do not.
const RUN_GRID_ONLY_PARAMETER_DEFINITIONS = {
  group_by: {
    encoding: "single",
    schema: z
      .literal("commit", { error: "group_by must be commit" })
      .describe(
        "Group the runs by commit instead of listing bundles: the response is a grid with one lane per calling workflow, environment and env var set, and in each lane one cell per commit, the cell holding every attempt of that test, configuration and commit across its jobs. Only commit is accepted. With it, sort, limit, cursor, search, outcome, last_attempt_outcome and rerun_number are not accepted; the configuration and workflow_path filters select lanes."
      ),
  },
  ran_on: {
    encoding: "csv",
    schema: RanOnValuesSchema.transform(canonicalValues)
      .optional()
      .describe(
        "Only with group_by=commit. Code sources whose runs to keep, comma-separated or repeated, as GET /api/tests defines them from the job's branch and the workflow run's trigger: main covers pushes and schedules on main; pull_request covers pull requests and ciflow tag pushes. Jobs named with rerun_disabled_tests belong to neither. Omit to keep every run that has a commit, whatever triggered it."
      ),
  },
  window: {
    encoding: "single",
    schema: WindowSchema.optional().describe(
      "Only with group_by=commit. Keep the jobs whose first attempt of the test started within this long before the request, with every attempt of those jobs, as the health table assigns a run to its windows; a job that started earlier and was rerun within the window is left out whole. Omit to keep every retained attempt."
    ),
  },
} as const;

const RUNS_GRID_PARAMETER_DEFINITIONS = {
  ...TEST_ID_DEFINITION,
  ...RUN_GRID_ONLY_PARAMETER_DEFINITIONS,
  ...RUN_FILTER_DEFINITIONS,
  env_vars: RUN_LIST_PARAMETER_DEFINITIONS.env_vars,
  workflow_path: RUN_LIST_PARAMETER_DEFINITIONS.workflow_path,
} as const;

const RunsGridParamsSchema = parameterSchema(RUNS_GRID_PARAMETER_DEFINITIONS);
export type RunsGridQuery = z.infer<typeof RunsGridParamsSchema>;

// The parameters of a page of bundles that a grid request may not carry.
const LIST_ONLY_PARAMETERS = Object.keys(RUN_LIST_PARAMETER_DEFINITIONS).filter(
  (name) => !(name in RUNS_GRID_PARAMETER_DEFINITIONS)
);

export function parseRunsGridParams(rawQuery: RawQuery) {
  const given = LIST_ONLY_PARAMETERS.find(
    (name) => rawQuery[name] !== undefined
  );
  if (given !== undefined) {
    return {
      success: false as const,
      error: new z.ZodError([
        {
          code: "custom",
          input: rawQuery[given],
          path: [given],
          message: `${given} does not apply with group_by=commit`,
        },
      ]),
    };
  }
  return parseParameters(
    rawQuery,
    RUNS_GRID_PARAMETER_DEFINITIONS,
    RunsGridParamsSchema
  );
}

// Every parameter the endpoint accepts in either form, for the document:
// the grid's own first, then the shared filters and the page's.
export const RUNS_PARAMETER_DEFINITIONS = {
  ...TEST_ID_DEFINITION,
  ...RUN_GRID_ONLY_PARAMETER_DEFINITIONS,
  // Required of a grid request, optional of the endpoint.
  group_by: {
    ...RUN_GRID_ONLY_PARAMETER_DEFINITIONS.group_by,
    schema: RUN_GRID_ONLY_PARAMETER_DEFINITIONS.group_by.schema.optional(),
  },
  ...RUN_LIST_PARAMETER_DEFINITIONS,
} as const;

export function runsListParameters() {
  const schema = parameterSchema(RUNS_PARAMETER_DEFINITIONS);
  return [
    pathParameter("test_id", schema.shape.test_id),
    ...parameterQueryParameters(
      schema.omit({ test_id: true }),
      RUNS_PARAMETER_DEFINITIONS
    ),
  ];
}
