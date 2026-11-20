import type { RawQuery } from "lib/api/parameters";
import {
  CASES_VIEWS,
  COMPARE_PRESETS,
  type DayRange,
  dayRangeParam,
  decodeTrail,
  DEFAULT_PRESET,
  DEFAULT_SHOW,
  type Dim,
  DRILL_SORTS,
  type DrillQuery,
  encodeTrail,
  type Pill,
  type Rollup,
  rootOf,
  type TrendsQuery,
} from "lib/api/tests/cost/contracts";
import { type Cells, CELLS, DEFAULT_CELLS } from "lib/api/tests/cost/page";
import {
  COST_V2_PAGE_PARAMETER_DEFINITIONS,
  showMax,
} from "lib/api/tests/cost/pageV2";
import {
  COST_WINDOWS,
  type CostWindow,
  DEFAULT_COST_WINDOW,
} from "lib/api/tests/cost/windows";
import { decodePageQuery, pageUrlParams } from "lib/api/tests/pages/parameters";
import type { CostChoices } from "lib/tests/cost/runnerHours";

// What the cost page V2 preview (/cost/v2) shows, read from and written to
// its URL under COST_V2_PAGE_PARAMETER_DEFINITIONS' names, defaults left off: the workflow
// scope (empty for every workflow), the trends' state (rollup, bars shown, A
// and B or a relative preset, per day or per commit, hours or $), the
// drill-down's (the trail and how its tables are drawn), and the days and
// cells of the owner-machine matrix. Nothing is checked against an answer
// here: names the data lacks stay in the URL, and the drill-down decides
// what to do with them once its answers are in (validTrail in drill.ts).
export interface CostQuery {
  window: CostWindow;
  workflows: string[];
  cells: Cells;
  only: boolean;
  trends: TrendsQuery;
  drill: DrillQuery;
}

function names(values: string[] | undefined): string[] {
  return Array.from(new Set(values ?? [])).filter((value) => value !== "");
}

function isDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const time = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(text);
}

// "2026-11-12..2026-11-18", or "2026-11-17" for one day, as a range of UTC
// days; null when malformed or backwards.
export function parseDayRange(text: string | undefined): DayRange | null {
  if (text === undefined) return null;
  const parts = text.split("..");
  const [from, to = from] = parts;
  if (parts.length > 2 || !isDay(from) || !isDay(to) || from > to) return null;
  return { from, to };
}

// A range as the page's URL writes it: one day alone, else from..to.
export function dayRangeText(range: DayRange): string {
  return range.from === range.to ? range.from : dayRangeParam(range);
}

// Bars shown, kept only when the rollup offers that many; null for the
// rollup's default.
function validShow(rollup: Rollup, show: number | null): number | null {
  if (show === null || !Number.isInteger(show)) return null;
  if (show < 1 || show > showMax(rollup) || show === DEFAULT_SHOW[rollup]) {
    return null;
  }
  return show;
}

// The trends' state as its parameters say. a and b are kept as asked, days
// before the data included (resolveCompare snaps and clips them); cmp is
// null when both are set, or when it is the rollup's default.
function resolveTrends(asked: ReturnType<typeof decodeCostPage>): TrendsQuery {
  const rollup: Rollup =
    asked.rollup === "week" || asked.rollup === "month" ? asked.rollup : "day";
  const a = parseDayRange(asked.a);
  const b = parseDayRange(asked.b);
  const cmp = COMPARE_PRESETS.find((p) => p === asked.cmp) ?? null;
  const show = /^\d+$/.test(asked.show ?? "") ? Number(asked.show) : null;
  return {
    rollup,
    show: validShow(rollup, show),
    cmp:
      (a !== null && b !== null) || cmp === DEFAULT_PRESET[rollup] ? null : cmp,
    a,
    b,
    per: asked.per === "commit" ? "commit" : "day",
    unit: asked.unit === "usd" ? "usd" : "hours",
  };
}

const DIMS: readonly Dim[] = ["o", "m", "f"];

// The drill-down's state as its parameters say. With no trail, an older
// link's highlight becomes one: its first owner and first machine, as
// written (nothing is dropped for being absent from an answer). root is
// what the trail's first pill implies, so a URL without root reads back the
// same.
function resolveDrill(asked: ReturnType<typeof decodeCostPage>): DrillQuery {
  let trail: Pill[] = decodeTrail(asked.trail);
  if (trail.length === 0) {
    const owner = names(asked.owner)[0];
    const machine = names(asked.machine)[0];
    trail = [
      ...(owner === undefined ? [] : [{ dim: "o" as const, value: owner }]),
      ...(machine === undefined ? [] : [{ dim: "m" as const, value: machine }]),
    ];
  }
  const more = new Set(asked.more ?? []);
  return {
    trail,
    // Machines first unless asked: the fleet's view.
    root: rootOf(trail, asked.root === "o" ? "o" : "m"),
    chg: asked.chg === "pct" ? "pct" : "h",
    sort: DRILL_SORTS.find((s) => s === asked.sort) ?? "change",
    more: DIMS.filter((d) => more.has(d)),
    tests: asked.tests === "1",
    cfg: /^\d+:\d+$/.test(asked.cfg ?? "") ? asked.cfg ?? null : null,
    cases: CASES_VIEWS.find((c) => c === asked.cases) ?? null,
    rank: asked.rank === "day" ? "day" : null,
  };
}

function decodeCostPage(url: RawQuery) {
  return decodePageQuery(url, COST_V2_PAGE_PARAMETER_DEFINITIONS);
}

export function resolveCostQuery(url: RawQuery): CostQuery {
  const asked = decodeCostPage(url);
  return {
    window: COST_WINDOWS.find((w) => w === asked.window) ?? DEFAULT_COST_WINDOW,
    workflows: names(asked.workflow).map((w) => w.toLowerCase()),
    cells: CELLS.find((c) => c === asked.cells) ?? DEFAULT_CELLS,
    only: asked.only === "1",
    trends: resolveTrends(asked),
    drill: resolveDrill(asked),
  };
}

// The 7-day answer's choices (computeView, knownChoices): the workflow
// scope, and the trail's owner and machine as the matrix's highlight.
export function costChoices(query: CostQuery): CostChoices {
  const pill = (dim: Dim) =>
    query.drill.trail.filter((p) => p.dim === dim).map((p) => p.value);
  return { workflows: query.workflows, owners: pill("o"), machines: pill("m") };
}

// The page's URL parameters for a query: every choice under its name, left
// off at its default, so a bare URL is the defaults. owner and machine are
// never written (undefined, so a merge drops an older link's), as a trail
// says the same.
export function costUrlParams(query: CostQuery) {
  const t = query.trends;
  const d = query.drill;
  const both = t.a !== null && t.b !== null;
  return pageUrlParams(
    {
      workflow: query.workflows,
      rollup: t.rollup,
      show: validShow(t.rollup, t.show)?.toString(),
      cmp:
        both || t.cmp === null || t.cmp === DEFAULT_PRESET[t.rollup]
          ? undefined
          : t.cmp,
      a: t.a === null ? undefined : dayRangeText(t.a),
      b: t.b === null ? undefined : dayRangeText(t.b),
      per: t.per,
      unit: t.unit,
      trail: encodeTrail(d.trail),
      root: d.trail.length === 0 ? d.root : undefined,
      chg: d.chg,
      sort: d.sort,
      more: DIMS.filter((dim) => d.more.includes(dim)),
      tests: d.tests ? "1" : "0",
      cfg: d.cfg ?? undefined,
      cases: d.cases ?? undefined,
      rank: d.rank ?? undefined,
      window: query.window,
      cells: query.cells,
      only: query.only ? "1" : "0",
      owner: undefined,
      machine: undefined,
    },
    COST_V2_PAGE_PARAMETER_DEFINITIONS
  );
}
