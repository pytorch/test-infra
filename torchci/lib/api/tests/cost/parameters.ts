import {
  canonicalValues,
  ParameterDefinition,
  parameterQueryParameters,
  parameterSchema,
  parseParameters,
  RawQuery,
} from "lib/api/parameters";
import {
  COST_WINDOWS,
  DEFAULT_COST_WINDOW,
  DEFAULT_TREND_ROLLUP,
  TREND_ROLLUPS,
} from "lib/api/tests/cost/windows";
import {
  exactValues,
  PARAMETER_DEFINITIONS as TEST_PARAMETERS,
} from "lib/api/tests/parameters";
import { z } from "zod/v4";

// The endpoint takes the repository and the window: its answer holds every
// owner, workflow and machine of the window's days, so whatever a reader
// scopes or highlights is summed from the one answer.
export const COST_PARAMETER_DEFINITIONS = {
  repo: TEST_PARAMETERS.repo,
  window: {
    encoding: "single",
    schema: z
      .enum(COST_WINDOWS, {
        error: `window must be one of: ${COST_WINDOWS.join(", ")}`,
      })
      .default(DEFAULT_COST_WINDOW)
      .describe(
        "The last whole UTC days the runner-hours cover, ending at the start of today."
      ),
  },
} as const satisfies Record<string, ParameterDefinition>;

export const CostParamsSchema = parameterSchema(COST_PARAMETER_DEFINITIONS);
export type CostParams = z.infer<typeof CostParamsSchema>;

export function parseCostParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    COST_PARAMETER_DEFINITIONS,
    CostParamsSchema
  );
}

export function costQueryParameters() {
  return parameterQueryParameters(CostParamsSchema, COST_PARAMETER_DEFINITIONS);
}

// The trend takes the repository, the rollup and the page's workflow scope:
// its answer holds every owner and runner label of each period, so owners
// are compared and priced from the one answer, while a scope, which the page
// changes rarely, is asked for.
export const COST_TREND_PARAMETER_DEFINITIONS = {
  repo: TEST_PARAMETERS.repo,
  rollup: {
    encoding: "single",
    schema: z
      .enum(TREND_ROLLUPS, {
        error: `rollup must be one of: ${TREND_ROLLUPS.join(", ")}`,
      })
      .default(DEFAULT_TREND_ROLLUP)
      .describe(
        "Each period's length: day (the last 42 whole UTC days), week (the last 26 weeks from Monday) or month (the last 13 calendar months), the last period running through yesterday."
      ),
  },
  workflow: {
    encoding: "repeat",
    schema: exactValues(z.string().min(1).max(100)).describe(
      "Workflows to count, by file name without its directory and .yml, lowercase: pull for .github/workflows/pull.yml. Repeat for several; every workflow when absent."
    ),
  },
} as const satisfies Record<string, ParameterDefinition>;

export const CostTrendParamsSchema = parameterSchema(
  COST_TREND_PARAMETER_DEFINITIONS
);
export type CostTrendParams = z.infer<typeof CostTrendParamsSchema>;

export function parseCostTrendParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    COST_TREND_PARAMETER_DEFINITIONS,
    CostTrendParamsSchema
  );
}

export function costTrendQueryParameters() {
  return parameterQueryParameters(
    CostTrendParamsSchema,
    COST_TREND_PARAMETER_DEFINITIONS
  );
}

// The longest period the changes compare, in days: the month rollup's
// longest preset, 3 months, fits twice over, and a period's read stays
// about a year of the trend's (query-validation.md).
export const MAX_CHANGE_DAYS = 400;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RANGE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

// A period as the changes take it, from..to, both whole UTC days and
// included; null unless both are real days, in order, at most
// MAX_CHANGE_DAYS apart.
export function parseDayRange(
  value: string
): { from: string; to: string } | null {
  const match = DAY_RANGE.exec(value);
  if (match === null) return null;
  const [from, to] = [match[1], match[2]];
  const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
  const real = (day: string) =>
    !Number.isNaN(ms(day)) && new Date(ms(day)).toISOString().startsWith(day);
  if (!real(from) || !real(to) || from > to) return null;
  return (ms(to) - ms(from)) / DAY_MS + 1 <= MAX_CHANGE_DAYS
    ? { from, to }
    : null;
}

function dayRange(name: "a" | "b", description: string) {
  const error = `${name} must be YYYY-MM-DD..YYYY-MM-DD, its first day no later than its last, at most ${MAX_CHANGE_DAYS} days`;
  return {
    encoding: "single",
    schema: z
      .string({
        error: (issue) =>
          issue.input === undefined ? `Missing required param: ${name}` : error,
      })
      .refine((value) => parseDayRange(value) !== null, { error })
      .describe(description),
  } as const;
}

// The changes take the two periods compared, the owners whose hours they
// are (every owner's when absent) and the page's workflow scope: an owner's
// test files are a few thousand cells, every owner's tens of thousands.
export const COST_CHANGES_PARAMETER_DEFINITIONS = {
  repo: TEST_PARAMETERS.repo,
  a: dayRange(
    "a",
    "The period compared against, A: whole UTC days from..to, both included, e.g. 2026-10-27..2026-11-02."
  ),
  b: dayRange(
    "b",
    "The period compared, B, as a is. It may overlap A: a day in both counts in both."
  ),
  owner: {
    encoding: "repeat",
    schema: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(50)
      .transform(canonicalValues)
      .optional()
      .describe(
        "Owners whose share of the runner-hours to count, as GET /api/tests/cost names them (a bucket such as unattributed:no_owner included); repeat for several, at most 50. Every owner when absent, and then no test files."
      ),
  },
  workflow: COST_TREND_PARAMETER_DEFINITIONS.workflow,
} as const satisfies Record<string, ParameterDefinition>;

export const CostChangesParamsSchema = parameterSchema(
  COST_CHANGES_PARAMETER_DEFINITIONS
);
export type CostChangesParams = z.infer<typeof CostChangesParamsSchema>;

export function parseCostChangesParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    COST_CHANGES_PARAMETER_DEFINITIONS,
    CostChangesParamsSchema
  );
}

export function costChangesQueryParameters() {
  return parameterQueryParameters(
    CostChangesParamsSchema,
    COST_CHANGES_PARAMETER_DEFINITIONS
  );
}

// Named scopes of workflows a reader picks in one click, published with the
// runner-hours. The PR critical path is what a pull request runs and must pass to
// merge.
export const WORKFLOW_PRESETS = [
  {
    value: "pr_critical_path",
    label: "PR Critical Path",
    description: "what a PR runs on each update and must pass to merge",
    workflows: ["pull", "trunk"],
  },
];

// The signals a pull request's author waits on, each measured by the workflow
// that gives it, as HUD's time to signal does on pushes to main: a stand-in
// for the wait on a pull request itself, not exact, but the numbers readers
// know.
export const SIGNALS = [
  {
    value: "pr_update",
    label: "PR update signals",
    workflow: "pull",
    description: "runs on every PR update",
  },
  {
    value: "pr_merge",
    label: "PR merge signals",
    workflow: "trunk",
    description: "must pass for a PR to merge",
  },
];
