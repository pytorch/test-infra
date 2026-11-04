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
} from "lib/api/tests/cost/windows";
import {
  decodePageQuery,
  pageUrlParams,
  testsPagePath,
} from "lib/api/tests/pages/parameters";

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

// A share as a whole percent, "<1%" for a sliver.
export function shareLabel(share: number): string {
  return share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
}
