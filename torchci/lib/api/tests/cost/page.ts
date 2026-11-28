import { type ParameterDefinition, parameterSchema } from "lib/api/parameters";
import {
  CASES_VIEWS,
  COMPARE_PRESETS,
  DRILL_SORTS,
  SHOW_OPTIONS,
} from "lib/api/tests/cost/contracts";
import { COST_PARAMETER_DEFINITIONS } from "lib/api/tests/cost/parameters";
import { z } from "zod/v4";

// The cost page, /tests/[organization]/[repo]/cost: the headline facts, the
// coverage banner, the trends (two periods A and B over daily, weekly or
// monthly bars) with the drill-down under them, then the workflows card.
// workflow is the scope, and a, b, cmp and trail what the figures are of; the
// other parameters are how they are drawn. The page reads and writes its URL
// with these (decodePageQuery, pageUrlParams; lib/tests/cost/query.ts) and
// the document lists the page from them. Zod and the registry only: the page
// imports this module into the browser.
export const COST_PAGE_PATH = "/tests/{organization}/{repo}/cost";

// The page's path for a repository given as owner/name, with no parameters.
export function costPagePath(repo: string): string {
  return `/tests/${repo}/cost`;
}

const DAY = "\\d{4}-\\d{2}-\\d{2}";
const DAY_RANGE = new RegExp(`^${DAY}(\\.\\.${DAY})?$`);
const RANGE_ERROR =
  "must be a UTC day, 2026-11-17, or two, 2026-11-12..2026-11-18";

function rangeParameter(description: string) {
  return {
    encoding: "single",
    schema: z
      .string()
      .regex(DAY_RANGE, { error: RANGE_ERROR })
      .optional()
      .describe(description),
  } as const satisfies ParameterDefinition;
}

// The most bars a rollup shows: its largest Show option.
export const showMax = (rollup: keyof typeof SHOW_OPTIONS): number =>
  Math.max(...SHOW_OPTIONS[rollup]);
const MAX_SHOW = showMax("day");

export const COST_PAGE_PARAMETER_DEFINITIONS = {
  workflow: {
    encoding: "repeat",
    schema: z
      .array(z.string())
      .optional()
      .describe(
        "The workflows whose runner-hours the page counts, lowercase as GET /api/tests/cost names them; repeat the parameter for several. Every workflow when absent; pull and trunk are the PR Critical Path preset."
      ),
  },
  rollup: {
    encoding: "single",
    schema: z
      .enum(["day", "week", "month"])
      .default("day")
      .describe(
        "What one trend bar is: a UTC day, a week from Monday or a calendar month. Every bar is summed from days, so a rollup changes the drawing, not the figures."
      ),
  },
  show: {
    encoding: "single",
    schema: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_SHOW)
      .optional()
      .describe(
        `How many bars the trend shows, the last ending yesterday: up to ${showMax(
          "day"
        )} days, ${showMax("week")} weeks or ${showMax(
          "month"
        )} months. 42 days, 52 weeks or 12 months when absent; a count past the rollup's limit reads as absent.`
      ),
  },
  cmp: {
    encoding: "single",
    schema: z
      .enum(COMPARE_PRESETS)
      .optional()
      .describe(
        "A relative comparison, so a bookmark stays current: dod (yesterday vs the day before), wow, mom, 7v7 (the last 7 days vs the 7 before) or 28v28. a and b win over it. dod, wow or mom by the rollup when absent."
      ),
  },
  a: rangeParameter(
    "Period A, the one compared against, as UTC days, both included: 2026-11-05..2026-11-11, or 2026-11-17 for one day. Snapped outward to whole bars. Days before the data stay, and read as no data."
  ),
  b: rangeParameter(
    "Period B, the one studied, written as a: 2026-11-12..2026-11-18. The coverage banner covers B's days."
  ),
  per: {
    encoding: "single",
    schema: z
      .enum(["day", "commit"])
      .default("day")
      .describe(
        "day (Total) sums each bar's runner-hours over its days, and reads A, B and the drill per bar of the rollup: a day, a week or a month, a partial bar counting as one whole bar; commit divides the hours of jobs on pushes to main by those pushes."
      ),
  },
  unit: {
    encoding: "single",
    schema: z
      .enum(["hours", "usd"])
      .default("hours")
      .describe(
        "usd prices every figure with the rates file added in the browser, which never leaves it; without a file it reads as hours. No price is ever in the URL."
      ),
  },
  trail: {
    encoding: "single",
    schema: z
      .string()
      .optional()
      .describe(
        "The drill-down's scope: up to one owner (o), machine (m) and test file (f), ';'-separated, each value URL-encoded after its letter and a colon: o:inductor;m:Linux%20x86_64%20avx512;f:test%2Finductor%2Ftest_flex_attention.py. The trend, the A/B summary and the tables follow it. Every owner when absent."
      ),
  },
  root: {
    encoding: "single",
    schema: z
      .enum(["o", "m"])
      .default("m")
      .describe(
        "What the drill-down lists first while trail is empty: m, the machines (the fleet view, the default); o, the owners."
      ),
  },
  chg: {
    encoding: "single",
    schema: z
      .enum(["h", "pct"])
      .default("h")
      .describe(
        "The drill-down's change column: h, the change in the unit; pct, in percent."
      ),
  },
  sort: {
    encoding: "single",
    schema: z
      .enum(DRILL_SORTS)
      .default("change")
      .describe(
        "The drill-down's row order, set by clicking a column header: change, the largest change either way first; grew or shrank, the largest growth or drop first; a or b, the largest in A or B first; pct, pctgrew and pctshrank, the same by percent."
      ),
  },
  more: {
    encoding: "csv",
    schema: z
      .array(z.enum(["o", "m", "f"]))
      .optional()
      .describe(
        "The drill-down lists shown in full rather than cut at their largest rows, comma-separated: o, m, f."
      ),
  },
  tests: {
    encoding: "single",
    schema: z
      .enum(["0", "1"])
      .default("0")
      .describe(
        "1 loads a test file's configurations and test cases (GET /api/tests/cost/cases, a heavy query behind a cheap gate)."
      ),
  },
  cfg: {
    encoding: "single",
    schema: z
      .string()
      .regex(/^\d+:\d+$/, { error: "must be <environments_id>:<env_vars_id>" })
      .optional()
      .describe(
        "The configuration the test cases are narrowed to: <environments_id>:<env_vars_id>, as GET /api/tests/cost/cases names them."
      ),
  },
  cases: {
    encoding: "single",
    schema: z
      .enum(CASES_VIEWS)
      .optional()
      .describe(
        "Which test cases are listed: shrank, grew, skipped, slower, newb (new in B) or failing. The biggest moves either way when absent."
      ),
  },
  rank: {
    encoding: "single",
    schema: z
      .enum(["day"])
      .optional()
      .describe(
        "day ranks the test cases by their change a day; by the change in time per run when absent."
      ),
  },
  window: {
    encoding: "single",
    schema: COST_PARAMETER_DEFINITIONS.window.schema.describe(
      "The last whole UTC days the PR signals and the workflows card count (GET /api/tests/cost's window)."
    ),
  },
  owner: {
    encoding: "repeat",
    schema: z
      .array(z.string())
      .optional()
      .describe(
        "Read from older links only: the first owner becomes the trail's owner (o:) when trail is absent. The page never writes it."
      ),
  },
  machine: {
    encoding: "repeat",
    schema: z
      .array(z.string())
      .optional()
      .describe(
        "Read from older links only: the first machine becomes the trail's machine (m:) when trail is absent. The page never writes it."
      ),
  },
} as const satisfies Record<string, ParameterDefinition>;

// Parameters older pages wrote that this one neither reads nor keeps: the
// next write drops them from the URL.
export const COST_PAGE_RETIRED_PARAMETERS = [
  "split_by",
  "cells",
  "only",
] as const;

export const CostPageQuerySchema = parameterSchema(
  COST_PAGE_PARAMETER_DEFINITIONS
);
