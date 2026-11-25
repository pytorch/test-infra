import {
  ParameterDefinition,
  parameterQueryParameters,
  parameterSchema,
  parseParameters,
  RawQuery,
} from "lib/api/parameters";
import {
  daysIn,
  decodeTrail,
  encodeTrail,
  MAX_JOB_COVERAGE_DAYS,
  type Pill,
} from "lib/api/tests/cost/contracts";
import {
  COST_WINDOWS,
  DEFAULT_COST_WINDOW,
  DEFAULT_TREND_ROLLUP,
  TREND_MAX_PERIODS,
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
const PERIODS_ERROR = `periods must be a whole number from 1 to ${TREND_MAX_PERIODS.day}`;

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
  periods: {
    encoding: "single",
    schema: z.coerce
      .number({ error: PERIODS_ERROR })
      .int({ error: PERIODS_ERROR })
      .min(1, { error: PERIODS_ERROR })
      .max(TREND_MAX_PERIODS.day, { error: PERIODS_ERROR })
      .optional()
      .describe(
        "How many periods, the last running through yesterday: 42 days, 26 weeks or 13 months when absent; at most 400 (weeks stop at 60, months at 14)."
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

// The longest period A, B or a series spans, in days: the month rollup's
// longest preset, 3 months, fits twice over, and a period's read stays
// about a year of the trend's (query-validation.md).
export const MAX_CHANGE_DAYS = 400;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RANGE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

// A period as the endpoints take it, from..to, both whole UTC days and
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

// The two periods compared, A and B, as /scope and /cases take them.
const PERIOD_A = dayRange(
  "a",
  "The period compared against, A: whole UTC days from..to, both included, e.g. 2026-10-27..2026-11-02."
);
const PERIOD_B = dayRange(
  "b",
  "The period compared, B, as a is. It may overlap A: a day in both counts in both."
);

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

// ── Drill, bars, banner and cases ──

// A drill trail as the page's URL spells it (encodeTrail): o:owner;m:machine;f:file,
// values URI-encoded, one pill per dimension, in drill order; empty for the
// root. Only the canonical spelling is accepted, so the answer's echo rebuilds
// the URL asked for; a file pill needs an owner or machine pill before it.
const TRAIL_ERROR =
  "trail must be pills dim:value joined by ';' (dims o, m, f, once each, values URI-encoded), a file pill after an owner or machine pill";

export function parseTrail(value: string): Pill[] | null {
  const pills = decodeTrail(value);
  if (encodeTrail(pills) !== value) return null;
  const file = pills.findIndex((p) => p.dim === "f");
  if (file === 0) return null;
  return pills.every((p) => p.value.length <= 300) ? pills : null;
}

const TRAIL = {
  encoding: "single",
  schema: z
    .string({ error: TRAIL_ERROR })
    .max(1000, { error: TRAIL_ERROR })
    .default("")
    .refine((value) => parseTrail(value) !== null, { error: TRAIL_ERROR })
    .transform((value) => parseTrail(value) as Pill[])
    .describe(
      "The drill scope, as the cost page's trail: pills dim:value joined by ';', dims o (owner, or a bucket such as unattributed:no_owner), m (machine, or Unknown machine) and f (test file), each once, values URI-encoded, e.g. o:inductor;m:Linux%20x86_64%20avx512. Every runner-hour of the scope when empty."
    ),
} as const;

const BY = {
  encoding: "single",
  schema: z
    .enum(["o", "m", "f", "lane", "label"], {
      error: (issue) =>
        issue.input === undefined
          ? "Missing required param: by"
          : "by must be one of: o, m, f, lane, label",
    })
    .describe(
      "What the scope's children are: o owners (and buckets), m machines (Unknown machine for test jobs whose label ran no reporting job that week), f test files, lane environment and workflow (environment id|workflow), label runner label and workflow (label|workflow)."
    ),
} as const;

function oneDay(name: string, description: string) {
  const error = `${name} must be a day, YYYY-MM-DD`;
  return {
    encoding: "single",
    schema: z
      .string({
        error: (issue) =>
          issue.input === undefined ? `Missing required param: ${name}` : error,
      })
      .refine((value) => parseDayRange(`${value}..${value}`) !== null, {
        error,
      })
      .describe(description),
  } as const;
}

// A from..to range of the endpoints that take one, both days included, at
// most max days; the issue names to.
function rangeIssue(max: number, what: string) {
  return (value: { from: string; to: string }, ctx: z.RefinementCtx) => {
    const range = parseDayRange(`${value.from}..${value.to}`);
    if (value.from > value.to) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "to must be on or after from",
      });
    } else if (range === null || daysIn(range) > max) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: `from..to must span at most ${max} days${
          what ? ` ${what}` : ""
        }`,
      });
    }
  };
}

export const COST_SCOPE_PARAMETER_DEFINITIONS = {
  repo: TEST_PARAMETERS.repo,
  a: PERIOD_A,
  b: PERIOD_B,
  trail: TRAIL,
  by: BY,
  workflow: COST_TREND_PARAMETER_DEFINITIONS.workflow,
  piece: {
    encoding: "single",
    schema: z
      .enum(["week", "day"], { error: "piece must be one of: week, day" })
      .default("week")
      .describe(
        "What a piece of the cells is: week, one side's days inside one ISO week and one calendar month; day, one day, for prices that change on any day."
      ),
  },
} as const satisfies Record<string, ParameterDefinition>;

export const CostScopeParamsSchema = parameterSchema(
  COST_SCOPE_PARAMETER_DEFINITIONS
);
export type CostScopeParams = z.infer<typeof CostScopeParamsSchema>;

export function parseCostScopeParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    COST_SCOPE_PARAMETER_DEFINITIONS,
    CostScopeParamsSchema
  );
}

export function costScopeQueryParameters() {
  return parameterQueryParameters(
    CostScopeParamsSchema,
    COST_SCOPE_PARAMETER_DEFINITIONS
  );
}

export const COST_SERIES_PARAMETER_DEFINITIONS = {
  repo: TEST_PARAMETERS.repo,
  trail: TRAIL,
  by: BY,
  from: oneDay("from", "The first day, YYYY-MM-DD (UTC)."),
  to: oneDay(
    "to",
    `The last day, YYYY-MM-DD, included; at most ${MAX_CHANGE_DAYS} days after from's.`
  ),
  workflow: COST_TREND_PARAMETER_DEFINITIONS.workflow,
} as const satisfies Record<string, ParameterDefinition>;

export const CostSeriesParamsSchema = parameterSchema(
  COST_SERIES_PARAMETER_DEFINITIONS
).superRefine(rangeIssue(MAX_CHANGE_DAYS, ""));
export type CostSeriesParams = z.infer<typeof CostSeriesParamsSchema>;

export function parseCostSeriesParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    COST_SERIES_PARAMETER_DEFINITIONS,
    CostSeriesParamsSchema
  );
}

export function costSeriesQueryParameters() {
  return parameterQueryParameters(
    parameterSchema(COST_SERIES_PARAMETER_DEFINITIONS),
    COST_SERIES_PARAMETER_DEFINITIONS
  );
}

export const COST_COVERAGE_PARAMETER_DEFINITIONS = {
  repo: TEST_PARAMETERS.repo,
  from: COST_SERIES_PARAMETER_DEFINITIONS.from,
  to: COST_SERIES_PARAMETER_DEFINITIONS.to,
  workflow: COST_TREND_PARAMETER_DEFINITIONS.workflow,
} as const satisfies Record<string, ParameterDefinition>;

export const CostCoverageParamsSchema = parameterSchema(
  COST_COVERAGE_PARAMETER_DEFINITIONS
).superRefine(rangeIssue(MAX_CHANGE_DAYS, ""));
export type CostCoverageParams = z.infer<typeof CostCoverageParamsSchema>;

export function parseCostCoverageParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    COST_COVERAGE_PARAMETER_DEFINITIONS,
    CostCoverageParamsSchema
  );
}

export function costCoverageQueryParameters() {
  return parameterQueryParameters(
    parameterSchema(COST_COVERAGE_PARAMETER_DEFINITIONS),
    COST_COVERAGE_PARAMETER_DEFINITIONS
  );
}

// The owner bars: B's runner-hours as GET /api/tests/cost's rows, for any
// range of days and workflow scope; by day only when $ asks for it.
export const COST_OWNERS_PARAMETER_DEFINITIONS = {
  repo: TEST_PARAMETERS.repo,
  from: COST_SERIES_PARAMETER_DEFINITIONS.from,
  to: COST_SERIES_PARAMETER_DEFINITIONS.to,
  workflow: COST_TREND_PARAMETER_DEFINITIONS.workflow,
  piece: {
    encoding: "single",
    schema: z
      .enum(["day"], { error: "piece must be day" })
      .optional()
      .describe(
        "day splits each row's runner-hours by day (cells), for prices that change on any day; one total per row when absent."
      ),
  },
} as const satisfies Record<string, ParameterDefinition>;

export const CostOwnersParamsSchema = parameterSchema(
  COST_OWNERS_PARAMETER_DEFINITIONS
).superRefine(rangeIssue(MAX_CHANGE_DAYS, ""));
export type CostOwnersParams = z.infer<typeof CostOwnersParamsSchema>;

export function parseCostOwnersParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    COST_OWNERS_PARAMETER_DEFINITIONS,
    CostOwnersParamsSchema
  );
}

export function costOwnersQueryParameters() {
  return parameterQueryParameters(
    parameterSchema(COST_OWNERS_PARAMETER_DEFINITIONS),
    COST_OWNERS_PARAMETER_DEFINITIONS
  );
}

export const COST_COVERAGE_JOBS_PARAMETER_DEFINITIONS = {
  repo: TEST_PARAMETERS.repo,
  from: oneDay("from", "The first day, YYYY-MM-DD (UTC)."),
  to: oneDay(
    "to",
    `The last day, YYYY-MM-DD, included; at most ${MAX_JOB_COVERAGE_DAYS} days after from's.`
  ),
} as const satisfies Record<string, ParameterDefinition>;

export const CostCoverageJobsParamsSchema = parameterSchema(
  COST_COVERAGE_JOBS_PARAMETER_DEFINITIONS
).superRefine(
  rangeIssue(
    MAX_JOB_COVERAGE_DAYS,
    "(a jobs scan; wider ranges wait for a jobs rollup)"
  )
);
export type CostCoverageJobsParams = z.infer<
  typeof CostCoverageJobsParamsSchema
>;

export function parseCostCoverageJobsParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    COST_COVERAGE_JOBS_PARAMETER_DEFINITIONS,
    CostCoverageJobsParamsSchema
  );
}

export function costCoverageJobsQueryParameters() {
  return parameterQueryParameters(
    parameterSchema(COST_COVERAGE_JOBS_PARAMETER_DEFINITIONS),
    COST_COVERAGE_JOBS_PARAMETER_DEFINITIONS
  );
}

export const COST_CASES_PARAMETER_DEFINITIONS = {
  repo: TEST_PARAMETERS.repo,
  file: {
    encoding: "single",
    schema: z
      .string({
        error: (issue) =>
          issue.input === undefined
            ? "Missing required param: file"
            : "file must be a test file path",
      })
      .min(1, { error: "file must be a test file path" })
      .max(300, { error: "file must be a test file path" })
      .describe(
        "The test file, as the tests catalog names it: test/inductor/test_flex_attention.py."
      ),
  },
  machine: {
    encoding: "single",
    schema: z
      .string({
        error: (issue) =>
          issue.input === undefined
            ? "Missing required param: machine"
            : "machine must be a machine name",
      })
      .min(1, { error: "machine must be a machine name" })
      .max(200, { error: "machine must be a machine name" })
      .describe(
        "The machine, as GET /api/tests/cost/scope names it: NVIDIA L4, Linux x86_64 avx512."
      ),
  },
  a: PERIOD_A,
  b: PERIOD_B,
  environment: {
    encoding: "single",
    schema: z
      .string({ error: "environment must be an environment id" })
      .regex(/^[1-9]\d{0,19}$/, {
        error: "environment must be an environment id",
      })
      .optional()
      .describe(
        "One environment of the machine (its id, a UInt64 as a decimal string): what a file too big to scan on every environment at once offers."
      ),
  },
} as const satisfies Record<string, ParameterDefinition>;

export const CostCasesParamsSchema = parameterSchema(
  COST_CASES_PARAMETER_DEFINITIONS
);
export type CostCasesParams = z.infer<typeof CostCasesParamsSchema>;

export function parseCostCasesParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    COST_CASES_PARAMETER_DEFINITIONS,
    CostCasesParamsSchema
  );
}

export function costCasesQueryParameters() {
  return parameterQueryParameters(
    CostCasesParamsSchema,
    COST_CASES_PARAMETER_DEFINITIONS
  );
}
