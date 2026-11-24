// The cost page: the types the page and its API share. Pure TypeScript with type-only imports (no zod or React at
// runtime), so lib/api and the page both import it.
import type { CostTrend } from "lib/api/tests/cost/types";
import type { EnvironmentRecord, EnvVarsRecord } from "lib/api/tests/types";
import type { CostUnit, PreparedHours } from "lib/tests/cost/runnerHours";
import type { ReactNode } from "react";

// ── Days (UTC) ──
export type Day = string; // YYYY-MM-DD
export interface DayRange {
  from: Day;
  to: Day;
} // both days included
const DAY_MS = 86_400_000;
const ms = (day: Day) => Date.parse(`${day}T00:00:00Z`);
export const addDays = (day: Day, n: number): Day =>
  new Date(ms(day) + n * DAY_MS).toISOString().slice(0, 10);
export const daysIn = (r: DayRange): number =>
  Math.round((ms(r.to) - ms(r.from)) / DAY_MS) + 1;
export const within = (r: DayRange, outer: DayRange): boolean =>
  r.from >= outer.from && r.to <= outer.to;
export const dayRangeParam = (r: DayRange): string => `${r.from}..${r.to}`;
// The browser's today. Only the first trend URL reads it. Once an answer is in, end, L, presets, folding and
// pricing read TrendContext.end: an open tab keeps its answer past 00:00 UTC while this clock moves on.
export const todayUtc = (): Day => new Date().toISOString().slice(0, 10);

// ── Trends state (URL rollup, show, cmp, a, b, per, unit) ──
export type Rollup = "day" | "week" | "month";
export const COMPARE_PRESETS = ["dod", "wow", "mom", "7v7", "28v28"] as const;
export type ComparePreset = (typeof COMPARE_PRESETS)[number];
export const DEFAULT_PRESET: Record<Rollup, ComparePreset> = {
  day: "dod",
  week: "wow",
  month: "mom",
};
export const SHOW_OPTIONS: Record<Rollup, readonly number[]> = {
  day: [14, 42, 90, 180, 365],
  week: [13, 26, 52],
  month: [6, 12],
};
export const DEFAULT_SHOW: Record<Rollup, number> = {
  day: 42,
  week: 52,
  month: 12,
};
export const MAX_TREND_DAYS = 400; // /trend?rollup=day&periods= cap (TREND_MAX_PERIODS.day = MAX_CHANGE_DAYS)
// periods= of the one trend request (rollup=day): the shown days plus a week, so an answer whose end is a day past
// the clock that built the URL (asked across 00:00 UTC) still holds every bar shownRange(…, answer.end) draws.
export const trendDaysParam = (shown: DayRange): number =>
  Math.min(MAX_TREND_DAYS, daysIn(shown) + 7);
export type Per = "day" | "commit";
export type Unit = "hours" | "usd"; // usd without a rates file reads as hours; never a price in the URL
export const costUnit = (u: Unit): CostUnit => (u === "usd" ? "cost" : "hours"); // for query.ts' frozen formatters
export interface TrendsQuery {
  rollup: Rollup;
  show: number | null; // bars shown; null = DEFAULT_SHOW[rollup]
  cmp: ComparePreset | null; // relative preset; null when a/b are set (or for the rollup default)
  a: DayRange | null;
  b: DayRange | null; // absolute and kept as asked (days before the data stay); a/b win over cmp
  per: Per;
  unit: Unit;
}
// A and B snapped outward to whole bars of the rollup and clipped at end − 1; never moved into the data (resolveCompare).
export interface Compare {
  rollup: Rollup;
  a: DayRange;
  b: DayRange;
  preset: ComparePreset | null;
}
// What presets, snapping, folding and pricing read from the trend answer (select.ts trendContext).
export interface TrendContext {
  end: Day; // the answer's today (exclusive): the only "today" once an answer is in
  firstDay: Day | null; // first day with data (2026-10-29 for pytorch/pytorch)
  lastFull: Day; // L: end − 1, or end − 2 while end − 1 is filling
  days: ReadonlySet<Day>;
  filling: ReadonlySet<Day>; // days with data; days still filling
}
// The bars' stack: a reviewed list for pytorch/pytorch, else the answer's 5 largest owners, frozen per answer.
const REVIEWED_OWNERS: Readonly<Record<string, readonly string[]>> = {
  "pytorch/pytorch": [
    "inductor",
    "core_tests",
    "dynamo",
    "distributed",
    "functorch",
  ],
};
export const namedOwners = (
  repo: string,
  ranked: readonly string[]
): readonly string[] =>
  REVIEWED_OWNERS[repo] ??
  ranked.filter((o) => !o.startsWith("unattributed:")).slice(0, 5);

// ── Drill state (URL trail, root, chg, sort, more, tests, cfg, cases, rank) ──
export type Dim = "o" | "m" | "f"; // owner (buckets too), machine (Unknown machine too), test file
export interface Pill {
  dim: Dim;
  value: string;
}
export type ScopeBy = "o" | "m" | "f" | "lane" | "label";
export const NO_TEST_REPORTS = "unattributed:no_test_reports";
export const NO_OWNER = "unattributed:no_owner";
export const UNKNOWN_MACHINE = "Unknown machine"; // = runnerHours.ts NOT_PROBED
export const CASES_VIEWS = [
  "shrank",
  "grew",
  "skipped",
  "slower",
  "newb",
  "failing",
] as const;
export type CasesView = (typeof CASES_VIEWS)[number];
// The drill-down's row orders, set by clicking a column header: change, the
// largest change either way (the default); grew and shrank, signed; a and b,
// the largest first; pct, pctgrew and pctshrank, the same three for %.
export const DRILL_SORTS = [
  "change",
  "grew",
  "shrank",
  "a",
  "b",
  "pct",
  "pctgrew",
  "pctshrank",
] as const;
export type DrillSort = (typeof DRILL_SORTS)[number];
export interface DrillQuery {
  trail: Pill[];
  root: "o" | "m"; // root: what the first level lists while the trail is empty
  chg: "h" | "pct";
  sort: DrillSort;
  more: Dim[]; // expanded "N more" lists
  tests: boolean; // configurations and cases asked for (a deep link asks again; the gate answers first)
  cfg: string | null; // "<environments_id>:<env_vars_id>": the configuration filtering the cases
  cases: CasesView | null; // the cases view chip; null = Biggest moves
  rank: "day" | null; // cases ranked by change a day; null = by change from time per run
}
// The level the trail's first pill implies; root while the trail is empty.
export const rootOf = (trail: readonly Pill[], root: "o" | "m"): "o" | "m" =>
  trail.length === 0 ? root : trail[0].dim === "m" ? "m" : "o";
// What a scope's children are: its canvas, its "+ next" pill, and the `by` of the bars' /series.
export function childBy(trail: readonly Pill[], root: "o" | "m"): ScopeBy {
  const pill = (dim: Dim) => trail.find((p) => p.dim === dim);
  if (trail.length === 0) return root;
  if (pill("f")) return pill("m") ? "lane" : "m";
  if (pill("o") && pill("m"))
    return pill("o")?.value === NO_TEST_REPORTS ? "label" : "f";
  return pill("o") ? "m" : "o";
}
// A hovered drill row the bars can split: a child of the bars' scope (root rows, canvas rows), named as the
// answer names children (a lane row = its "env_id|workflow" children). Sibling rows in the table don't hover.
export interface Hover {
  by: ScopeBy;
  children: string[];
}
// What the trend bars follow: the trail (with a previewed sibling swapped in) and the hovered row.
export interface BarsScope {
  trail: Pill[];
  root: "o" | "m";
  by: ScopeBy; // by = childBy(trail, root)
  fromTrend: boolean; // owner root only: bars read /trend. Every other scope reads /series(trail, by), the drill's machine definition
  preview: boolean;
  hover: Hover | null;
}
const isDim = (v: string): v is Dim => v === "o" || v === "m" || v === "f";
// trail=o:inductor;m:Linux%20x86_64%20avx512 — values encodeURIComponent'd, split on the first ':', one pill per dim.
export function encodeTrail(trail: readonly Pill[]): string {
  return trail.map((p) => `${p.dim}:${encodeURIComponent(p.value)}`).join(";");
}
export function decodeTrail(text: string | null | undefined): Pill[] {
  const pills: Pill[] = [];
  for (const part of (text ?? "").split(";")) {
    const dim = part.slice(0, 1);
    if (
      part.charAt(1) !== ":" ||
      !isDim(dim) ||
      pills.some((p) => p.dim === dim)
    )
      continue;
    let value = "";
    try {
      value = decodeURIComponent(part.slice(2));
    } catch {
      continue;
    }
    if (value !== "") pills.push({ dim, value });
  }
  return pills;
}

// ── API answers: the API's zod schemas infer to exactly these (test/api/tests/cost/contracts.test.ts). Each echoes its
// request (workflows sorted, trail canonical) so current() tells a kept previous answer from this URL's. ──
// Machine, in /scope and /series alike (one SQL builder): the environment's machine; else the machine the runner
// label's reporting rows ran on most in that ISO week; else Unknown machine.
export interface ScopeSide {
  days: Day[];
  pushes: number[];
  filling: Day[];
} // days the rollup holds; pushes to main aligned with days
// One side's run of days inside one ISO week and one calendar month:
// [max(week start, month start, side.from), min(week end, month end, side.to)]; with piece=day, one day.
// Overlapping A and B get a piece each.
export interface ScopePiece {
  side: 0 | 1;
  from: Day;
  to: Day;
}
// What a /scope piece is: week (as above) in hours; day in $, so a rate period starting on any day splits no piece.
// The request says only that $ is on, never anything of the rates file.
export type PieceSpan = "week" | "day";
export interface ScopeChildInfo {
  family?: string;
  short?: string;
  device?: string;
  cpu?: string; // by=m (machinesQuery): hues, tests-list facets
  coOwners?: string[]; // by=f: the file's owners when it has more than one
  environment?: EnvironmentRecord;
  workflow?: string;
  label?: string; // by=lane | label
}
// GET /api/tests/cost/scope: the children (by) of a trail scope in A and B.
export interface CostScope {
  repo: string;
  workflows: string[];
  trail: Pill[];
  by: ScopeBy;
  a: DayRange;
  b: DayRange;
  piece: PieceSpan;
  sides: [ScopeSide, ScopeSide]; // per day ÷ sides[s].days.length; per commit ÷ Σ sides[s].pushes (priced days only in $)
  pieces: ScopePiece[]; // price a cell with pricer.piece(label, the days of sides[piece.side].days inside the piece)
  children: string[];
  info: ScopeChildInfo[]; // API names (unattributed:*, Unknown machine, env_id|workflow, label|workflow)
  labels: string[]; // runner labels as jobs asked for them, comma-joined
  cells: [
    side: number,
    piece: number,
    child: number,
    label: number,
    h: number,
    mainH: number
  ][];
  tests: [side: number, child: number, executedH: number, skippedH: number][]; // by=f | lane only
  query_duration_ms: number;
}
// GET /api/tests/cost/series: one scope's hours by day, child (by) and label: the bars of every scope but the owner root.
export const SERIES_TOP = 30; // by=f | lane | label: children kept, by hours in [from, to]
export interface CostSeries {
  repo: string;
  workflows: string[];
  trail: Pill[];
  by: ScopeBy;
  from: Day;
  to: Day;
  days: Day[];
  pushes: number[];
  filling: Day[]; // days the rollup holds; pushes aligned with days
  children: string[];
  rest: boolean; // rest: the last child ("") is every child past SERIES_TOP
  labels: string[];
  cells: [
    day: number,
    child: number,
    label: number,
    h: number,
    mainH: number
  ][];
  query_duration_ms: number;
}
// GET /api/tests/cost/cases (ci.runs, last 14 days). A cheap gate runs first; the heavy scan only when it passes.
export const CASES_TOP = 200; // test × configuration cells ranked by |change in test time a day|, plus B's 50 largest
export interface CasesSide extends DayRange {
  covered_from: Day | null;
  covered_days: number;
} // from/to as asked
export interface CasesLane {
  environment: string;
  estimate: number;
  tooBig: boolean;
} // the gate per environment
export interface CostCases {
  repo: string;
  file: string;
  machine: string;
  environment: string | null;
  a: CasesSide;
  b: CasesSide;
  status: "ok" | "too_big"; // too_big: the gate predicts more than 45 s at 4 threads; nothing scanned, configs/cells empty
  lanes: CasesLane[]; // what "Try one environment" offers
  environments: EnvironmentRecord[];
  env_vars: EnvVarsRecord[];
  tests: { id: string; suite: string; name: string }[];
  // every configuration, exact (server GROUP BY): tests = distinct tests
  configs: [
    side: number,
    env: number,
    envVars: number,
    tests: number,
    runs: number,
    skipped: number,
    failed: number,
    reruns: number,
    testMs: number
  ][];
  // the ranked cells only; the rest of a side = Σ configs − Σ cells
  cells: [
    side: number,
    test: number,
    env: number,
    envVars: number,
    runs: number,
    skipped: number,
    failed: number,
    reruns: number,
    testMs: number
  ][];
  ranked_of: number; // test × configuration cells in all
  query_duration_ms: number;
}
// GET /api/tests/cost/coverage (test_cost, any range since the data starts) and /coverage/jobs (workflow_job, ≤ 28 days).
export const COVERAGE_SEGMENTS = [
  "running",
  "setup_idle",
  "no_reports",
  "out_of_scope",
] as const;
export const JOB_SEGMENTS = ["other_repos", "repo_all"] as const;
export const MAX_JOB_COVERAGE_DAYS = 28;
// The page asks /coverage/jobs once for this window and slices B from it; every enabled preset's B fits.
export const JOBS_WINDOW_DAYS = 14;
export const jobsWindow = (end: Day): DayRange => ({
  from: addDays(end, -JOBS_WINDOW_DAYS),
  to: addDays(end, -1),
});
export interface CostCoverage {
  repo: string;
  workflows: string[];
  from: Day;
  to: Day;
  days: Day[];
  labels: string[];
  cells: [day: number, segment: number, label: number, h: number][]; // segment indexes COVERAGE_SEGMENTS
  with_reports_h: number;
  owned_h: number;
  query_duration_ms: number;
}
export interface CostCoverageJobs {
  repo: string;
  org: string;
  from: Day;
  to: Day;
  repos: number;
  labels: string[];
  cells: [day: number, segment: number, label: number, h: number][]; // segment indexes JOB_SEGMENTS
  query_duration_ms: number;
}

// ── Request URLs (workflows sorted, so one scope is one cache key) ──
function apiUrl(
  path: string,
  params: [string, string][],
  workflows: readonly string[] = []
): string {
  const search = new URLSearchParams(params);
  for (const w of [...workflows].sort()) search.append("workflow", w);
  return `/api/tests/cost${path}?${search}`;
}
export const costTrendDaysUrl = (
  repo: string,
  workflows: readonly string[],
  days: number
) =>
  apiUrl(
    "/trend",
    [
      ["repo", repo],
      ["rollup", "day"],
      ["periods", String(Math.min(days, MAX_TREND_DAYS))],
    ],
    workflows
  );
export const costScopeUrl = (
  repo: string,
  workflows: readonly string[],
  a: DayRange,
  b: DayRange,
  trail: readonly Pill[],
  by: ScopeBy,
  piece: PieceSpan = "week"
) =>
  apiUrl(
    "/scope",
    [
      ["repo", repo],
      ["a", dayRangeParam(a)],
      ["b", dayRangeParam(b)],
      ["trail", encodeTrail(trail)],
      ["by", by],
      ...(piece === "day" ? ([["piece", "day"]] as [string, string][]) : []),
    ],
    workflows
  );
export const costSeriesUrl = (
  repo: string,
  workflows: readonly string[],
  trail: readonly Pill[],
  by: ScopeBy,
  range: DayRange
) =>
  apiUrl(
    "/series",
    [
      ["repo", repo],
      ["trail", encodeTrail(trail)],
      ["by", by],
      ["from", range.from],
      ["to", range.to],
    ],
    workflows
  );
export const costCasesUrl = (
  repo: string,
  file: string,
  machine: string,
  a: DayRange,
  b: DayRange,
  environment?: string
) =>
  apiUrl("/cases", [
    ["repo", repo],
    ["file", file],
    ["machine", machine],
    ["a", dayRangeParam(a)],
    ["b", dayRangeParam(b)],
    ...(environment
      ? ([["environment", environment]] as [string, string][])
      : []),
  ]);
export const costCoverageUrl = (
  repo: string,
  workflows: readonly string[],
  range: DayRange
) =>
  apiUrl(
    "/coverage",
    [
      ["repo", repo],
      ["from", range.from],
      ["to", range.to],
    ],
    workflows
  );
export const costCoverageJobsUrl = (repo: string, range: DayRange) =>
  apiUrl("/coverage/jobs", [
    ["repo", repo],
    ["from", range.from],
    ["to", range.to],
  ]);

// keepPreviousData hands back the last URL's answer while this URL loads. An answer is current when its echo rebuilds
// the URL asked for. Draw anything else dimmed, and never validate the trail or write the URL from it.
export function current<T>(
  data: T | undefined,
  url: string | null,
  echo: (answer: T) => string
): T | undefined {
  return data !== undefined && url !== null && echo(data) === url
    ? data
    : undefined;
}
export const trendEcho = (t: CostTrend) =>
  costTrendDaysUrl(t.repo, t.workflows, t.periods.length);
export const scopeEcho = (s: CostScope) =>
  costScopeUrl(s.repo, s.workflows, s.a, s.b, s.trail, s.by, s.piece);
export const seriesEcho = (s: CostSeries) =>
  costSeriesUrl(s.repo, s.workflows, s.trail, s.by, { from: s.from, to: s.to });
export const casesEcho = (c: CostCases) =>
  costCasesUrl(c.repo, c.file, c.machine, c.a, c.b, c.environment ?? undefined);
export const coverageEcho = (c: CostCoverage) =>
  costCoverageUrl(c.repo, c.workflows, { from: c.from, to: c.to });
export const jobsEcho = (c: CostCoverageJobs) =>
  costCoverageJobsUrl(c.repo, { from: c.from, to: c.to });

// ── Rates, in browser memory only (ratePeriods.ts implements) ──
export interface RatePeriod {
  validFrom: Day | null;
  validThrough: Day | null; // null only for a legacy one-set file
  rates: Readonly<Record<string, number>>;
  status: "final" | "provisional" | null;
  window: { start: Day; end: Day } | null;
}
export interface RatesSet {
  file: string;
  metaFile: string | null;
  basis: string | null;
  generatedAt: string | null;
  legacy: boolean;
  periods: readonly RatePeriod[]; // sorted, non-overlapping
}
export type RateDayKind =
  | "legacy"
  | "final"
  | "provisional"
  | "borrowed"
  | "gap";
export interface RateSegment {
  from: Day;
  to: Day;
  kind: RateDayKind;
  period: number | null;
}
// A label's price over some days with data: rate = mean $/h of the priced days (even weights); priced = share of
// the days priced (0..1); exact = one rate set prices every day. $ = h·priced·rate; unpriced h = rate === null ? h : h·(1 − priced).
export interface PieceRate {
  rate: number | null;
  priced: number;
  exact: boolean;
  borrowed: boolean;
}
export interface Pricer {
  readonly set: RatesSet;
  readonly today: Day; // TrendContext.end
  rate(label: string, day: Day): number | null; // label as the API names it; multi-label jobs → null
  piece(label: string, days: readonly Day[]): PieceRate; // days with data inside one ScopePiece
  dayKind(day: Day): RateDayKind;
  segments(range: DayRange): RateSegment[]; // clipped to range, gaps included
  coverageLine(range: DayRange, unpricedHours: number): string | null; // null when unremarkable
}

// ── Component props ──
export interface StripGeometry {
  bars: { start: Day; days: number }[]; // shown bars, left to right, calendar days each
  last: Day; // last day drawn; nothing after it
  // $, hours and unpriced hours of the bars' scope and per over those days. The strip's segments are the file's
  // rate periods and never move with the trail; only their $/h labels follow the bars' scope.
  priceSpan(range: DayRange): { usd: number; hours: number; unpriced: number };
  onHoverSpan(range: DayRange | null): void; // tints the bars' share of those days
}
export interface RateStripProps extends StripGeometry {
  pricer: Pricer;
}
export interface RatesControlProps {
  rates: RatesSet | null;
  error: string | null;
  dragging: boolean;
  exampleLabels: string[];
  onFiles(files: File[]): void;
  onClear(): void;
  onDismissError(): void;
}
export interface TrendsPanelProps {
  answer: CostTrend | undefined;
  context: TrendContext | null; // trendContext(answer): the panel never reads the clock
  loading: boolean; // no current answer for the trend URL: draw the kept one dimmed
  query: TrendsQuery;
  compare: Compare | null;
  onQueryChange(patch: Partial<TrendsQuery>): void;
  pricer: Pricer | null; // null: $ disabled
  runnerHours: PreparedHours | undefined; // 7-day answer: machine hues (prepared.colored) only, never a label → machine map
  scope: BarsScope;
  series: CostSeries | undefined; // current /series(scope) unless scope.fromTrend
  seriesLoading: boolean; // draw the last bars dimmed meanwhile
  workflowScope: string | null; // band subtitle; null = all workflows
  slots: { trail?: ReactNode; head?: ReactNode; table?: ReactNode };
  renderStrip?(geometry: StripGeometry): ReactNode; // the rate strip; called only in $ mode
}
export interface DrillInput {
  repo: string | undefined;
  workflows: string[];
  compare: Compare | null; // settled (useSettled, 400 ms): /scope refetches once a gesture stops
  query: DrillQuery;
  onQueryChange(patch: Partial<DrillQuery>): void;
  per: Per;
  rollup: Rollup; // Total reads per bar of it: a day, a week, a month
  unit: Unit;
  pricer: Pricer | null;
  runnerHours: PreparedHours | undefined; // hues only
}
export interface DrillModelBase {
  bars: BarsScope;
}
export interface CoverageBannerProps {
  repo: string | undefined;
  workflows: string[];
  b: DayRange | null;
  shown: DayRange | null;
  end: Day | null; // end = TrendContext.end
  unit: Unit;
  pricer: Pricer | null;
}
