import type { RawQuery } from "lib/api/parameters";
import {
  type Cells,
  CELLS,
  COST_PAGE_PARAMETER_DEFINITIONS,
  costPagePath,
  DEFAULT_CELLS,
} from "lib/api/tests/cost/page";
import {
  COST_WINDOWS,
  type CostWindow,
  DEFAULT_COST_WINDOW,
  type TrendRollup,
} from "lib/api/tests/cost/windows";
import {
  decodePageQuery,
  pageUrlParams,
  testsPagePath,
} from "lib/api/tests/pages/parameters";
import type { CostUnit } from "lib/tests/cost/runnerHours";

// What the cost page shows, read from and written to its URL under
// COST_PAGE_PARAMETER_DEFINITIONS' names, defaults left off: the window, the
// workflow scope (empty for every workflow), the owners and machines highlighted,
// whether bars are split by machine, what the matrix's cells show and
// whether it hides what is not highlighted. Names the API's answer does not
// hold are dropped once it arrives (knownChoices in runnerHours.ts).
export interface CostQuery {
  window: CostWindow;
  workflows: string[];
  owners: string[];
  machines: string[];
  split: boolean;
  cells: Cells;
  only: boolean;
}

function names(values: string[] | undefined): string[] {
  return Array.from(new Set(values ?? [])).filter((value) => value !== "");
}

export function resolveCostQuery(url: RawQuery): CostQuery {
  const asked = decodePageQuery(url, COST_PAGE_PARAMETER_DEFINITIONS);
  return {
    window: COST_WINDOWS.find((w) => w === asked.window) ?? DEFAULT_COST_WINDOW,
    workflows: names(asked.workflow).map((w) => w.toLowerCase()),
    owners: names(asked.owner),
    machines: names(asked.machine),
    split: asked.split_by !== "none",
    cells: CELLS.find((c) => c === asked.cells) ?? DEFAULT_CELLS,
    only: asked.only === "1",
  };
}

export function costUrlParams(query: CostQuery) {
  return pageUrlParams(
    {
      window: query.window,
      workflow: query.workflows,
      owner: query.owners,
      machine: query.machines,
      split_by: query.split ? "machine" : "none",
      cells: query.cells,
      only: query.only ? "1" : "0",
    },
    COST_PAGE_PARAMETER_DEFINITIONS
  );
}

// The GET /api/tests/cost request: the repository and the window.
export function costApiUrl(repo: string, window: CostWindow): string {
  return `/api/tests/cost?${new URLSearchParams({ repo, window })}`;
}

// The GET /api/tests/cost/trend request: the repository, the rollup and the
// page's workflow scope, sorted, so one scope is one URL in the cache.
export function costTrendApiUrl(
  repo: string,
  rollup: TrendRollup,
  workflows: readonly string[]
): string {
  const params = new URLSearchParams({ repo, rollup });
  for (const w of [...workflows].sort()) params.append("workflow", w);
  return `/api/tests/cost/trend?${params}`;
}

// What changed between two periods, from..to each, for some owners (every
// owner when none), in a workflow scope; owners and workflows sorted, so the
// URL, and the cache, do not depend on the order they were chosen in.
export function costChangesApiUrl(
  repo: string,
  workflows: readonly string[],
  owners: readonly string[],
  a: { from: string; to: string },
  b: { from: string; to: string }
): string {
  const params = new URLSearchParams({
    repo,
    a: `${a.from}..${a.to}`,
    b: `${b.from}..${b.to}`,
  });
  for (const o of [...owners].sort()) params.append("owner", o);
  for (const w of [...workflows].sort()) params.append("workflow", w);
  return `/api/tests/cost/changes?${params}`;
}

// Where an owner's runner-hours lead: the tests page narrowed to the owner,
// whose tests they are.
export function ownerTestsHref(repo: string, owner: string): string {
  return `${testsPagePath(repo)}?${new URLSearchParams({ owner })}`;
}

export { costPagePath };

const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

// Runner-hours as the page writes them: "740", "54.1K", "19.7M".
export function hoursLabel(hours: number): string {
  return hours < 1000 ? hours.toFixed(0) : COMPACT.format(hours);
}

// An amount in its unit: "54.1K h", "$54.1K", "<1 h" for a sliver.
export function amountLabel(unit: CostUnit, value: number): string {
  if (value > 0 && value < 0.5) return unit === "cost" ? "<$1" : "<1 h";
  return unit === "cost" ? `$${hoursLabel(value)}` : `${hoursLabel(value)} h`;
}

// An amount to a tenth of an hour or a cent under 10, as amountLabel above:
// a commit's runner-hours, and a test file's share of them, are often
// fractions of an hour. Whole amounts keep no decimals: "8 h", "$8".
export function fineAmountLabel(unit: CostUnit, value: number): string {
  if (value === 0 || Math.abs(value) >= 10) return amountLabel(unit, value);
  if (unit === "cost") {
    if (Math.abs(value) < 0.005) return "<$0.01";
    const cents = value.toFixed(2);
    return `$${cents.endsWith(".00") ? cents.slice(0, -3) : cents}`;
  }
  if (Math.abs(value) < 0.05) return "<0.1 h";
  const tenths = value.toFixed(1);
  return `${tenths.endsWith(".0") ? tenths.slice(0, -2) : tenths} h`;
}

// A unit's name in a sentence.
export const UNIT_NAMES: Record<CostUnit, string> = {
  hours: "runner-hours",
  cost: "cost",
};

// A rate as the page writes it: "$1.25/h", and to 3 significant figures
// under a dollar, "$0.647/h", so a rate and an edit of it never read alike.
export function rateLabel(rate: number): string {
  if (rate <= 0 || rate >= 1) return `$${rate.toFixed(2)}/h`;
  const [whole, frac = ""] = rate.toPrecision(3).split(".");
  return `$${whole}.${frac.replace(/0+$/, "").padEnd(2, "0")}/h`;
}

// UTC days as the page writes a range of them: "2026-11-03", "2026-10-28 to
// 11-03", the year again only when it changes. Read as text, so no time zone
// moves a day.
export function datesLabel(first: string, last: string): string {
  if (first === last) return first;
  return `${first} to ${
    last.slice(0, 4) === first.slice(0, 4) ? last.slice(5) : last
  }`;
}

// A share as a whole percent, "<1%" for a sliver and ">99%" for all but
// one, so a part never reads as none or as the whole.
export function shareLabel(share: number): string {
  if (share > 0 && share < 0.01) return "<1%";
  if (share > 0.99 && share < 1) return ">99%";
  return `${Math.round(share * 100)}%`;
}
