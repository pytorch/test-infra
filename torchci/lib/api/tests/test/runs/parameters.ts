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

export const RUNS_PARAMETER_DEFINITIONS = {
  test_id: { encoding: "single", schema: TestIdSchema },
  ...RUN_LIST_PARAMETER_DEFINITIONS,
} as const;

export const RunsListParamsSchema = parameterSchema(RUNS_PARAMETER_DEFINITIONS);
export const RunsListQuerySchema = RunsListParamsSchema.omit({ cursor: true });
export type RunsListQuery = z.infer<typeof RunsListQuerySchema>;

export function parseRunsListParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    RUNS_PARAMETER_DEFINITIONS,
    RunsListParamsSchema
  );
}

export function runsListParameters() {
  return [
    pathParameter("test_id", RunsListParamsSchema.shape.test_id),
    ...parameterQueryParameters(
      RunsListParamsSchema.omit({ test_id: true }),
      RUNS_PARAMETER_DEFINITIONS
    ),
  ];
}
