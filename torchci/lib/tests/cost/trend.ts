import type { CostTrend } from "lib/api/tests/cost/types";
import type { TrendRollup } from "lib/api/tests/cost/windows";
import { rateOf, type RatesBudget, type RatesFile } from "lib/tests/cost/rates";
import {
  BUCKET_LABELS,
  type CostUnit,
  isBucket,
} from "lib/tests/cost/runnerHours";

// The cost page's trend: GET /api/tests/cost/trend's runner-hours by period,
// owner and runner label, summed in the browser into two periods compared,
// A and B, the owners ranked by their change, and with a rates file, $ and
// the year to date against its budget. Pure functions of the answer and the
// reader's choices, as runnerHours.ts's are; TrendPanel only draws them.
//
// Periods are compared per day with data, so a week missing a day, or the
// current one through yesterday, compares fairly with a whole one, and a
// period is partial when it has fewer days with data than calendar days; or
// per commit: the runner-hours of pushes to main (trigger push:main) over
// the pushes to main on those days, what a push to main costs. Main runs
// every test, with no target determination, so it is a normalized unit
// cost, which weekends and quiet days do not skew.
// The owner highlight is the page's: the highlighted owners' share of each
// bar, their figures in the cards; the panel's Owner key steps it through
// the owners in the table's order. B's pace is its value per day kept up
// for the year, a month a twelfth of that.

const DAY_MS = 24 * 60 * 60 * 1000;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface PreparedTrend {
  rollup: TrendRollup;
  // Today, exclusive.
  end: string;
  // Each period's first day, from the first period with data.
  periods: string[];
  // Each period's calendar days, those through yesterday, and those with
  // data.
  periodDays: number[];
  periodElapsed: number[];
  periodData: number[];
  // Whether a period holds a day still filling: computed before the jobs
  // that started on it had all finished, so it reads low.
  periodFilling: boolean[];
  fillingDays: string[];
  owners: string[];
  labels: string[];
  cellPeriod: Int32Array;
  cellOwner: Int32Array;
  cellLabel: Int32Array;
  cellHours: Float64Array;
  // Those of pushes to main, part of cellHours.
  cellMain: Float64Array;
  // Each day's runner-hours by label from January 1 (or the first period,
  // if earlier), for the year to date; dailyStart is that first day.
  dailyStart: string;
  dailyDays: string[];
  dailyDay: Int32Array;
  dailyLabel: Int32Array;
  dailyHours: Float64Array;
  // Each period's pushes to main on its days with data.
  periodPushes: number[];
}

// What periods are compared by: per day with data, or per commit (a push to
// main).
export type TrendPer = "day" | "commit";

function calendarDays(rollup: TrendRollup, start: string): number {
  if (rollup === "day") return 1;
  if (rollup === "week") return 7;
  const d = new Date(dayMs(start));
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
  ).getUTCDate();
}

export function prepareTrend(answer: CostTrend): PreparedTrend {
  const endMs = dayMs(answer.end);
  const starts = answer.periods.map(dayMs);
  const days = answer.periods.map((p) => calendarDays(answer.rollup, p));
  const data = new Array<number>(answer.periods.length).fill(0);
  const filling = new Array<boolean>(answer.periods.length).fill(false);
  const pushes = new Array<number>(answer.periods.length).fill(0);
  // An answer cached from before the API counted pushes has none.
  const dayPushes: number[] = answer.daily.pushes ?? [];
  // An answer cached from before the API listed filling days has none.
  const fillingList: string[] = answer.daily.filling ?? [];
  const fillingDays = new Set(fillingList);
  // Days with data per period, from the daily totals' days.
  let i = 0;
  for (const [d, day] of answer.daily.days.entries()) {
    const ms = dayMs(day);
    while (i < starts.length - 1 && ms >= starts[i + 1]) i++;
    if (ms >= starts[i] && ms < starts[i] + days[i] * DAY_MS) {
      data[i]++;
      pushes[i] += dayPushes[d] ?? 0;
      if (fillingDays.has(day)) filling[i] = true;
    }
  }
  // From the first period with data: before it the rollup did not exist.
  const withCells = new Set(answer.cells.map((c) => c[0]));
  let first = answer.periods.findIndex(
    (_, p) => data[p] > 0 || withCells.has(p)
  );
  if (first < 0) first = answer.periods.length;
  const n = answer.cells.length;
  const cellPeriod = new Int32Array(n);
  const cellOwner = new Int32Array(n);
  const cellLabel = new Int32Array(n);
  const cellHours = new Float64Array(n);
  const cellMain = new Float64Array(n);
  answer.cells.forEach(([p, o, l, h, main], c) => {
    cellPeriod[c] = p - first;
    cellOwner[c] = o;
    cellLabel[c] = l;
    cellHours[c] = h;
    cellMain[c] = main ?? 0;
  });
  const m = answer.daily.cells.length;
  const dailyDay = new Int32Array(m);
  const dailyLabel = new Int32Array(m);
  const dailyHours = new Float64Array(m);
  answer.daily.cells.forEach(([d, l, h], c) => {
    dailyDay[c] = d;
    dailyLabel[c] = l;
    dailyHours[c] = h;
  });
  return {
    rollup: answer.rollup,
    end: answer.end,
    periods: answer.periods.slice(first),
    periodDays: days.slice(first),
    periodElapsed: starts
      .map((s, p) => Math.min(days[p], Math.round((endMs - s) / DAY_MS)))
      .slice(first),
    periodData: data.slice(first),
    periodFilling: filling.slice(first),
    fillingDays: fillingList,
    owners: answer.owners,
    labels: answer.labels,
    cellPeriod,
    cellOwner,
    cellLabel,
    cellHours,
    cellMain,
    dailyStart: answer.daily.start,
    dailyDays: answer.daily.days,
    dailyDay,
    dailyLabel,
    dailyHours,
    periodPushes: pushes.slice(first),
  };
}

// Whether the trend can be read by a rollup: a day always; a week or a
// month once its last two whole periods through yesterday have data on
// every day, so A and B have whole periods to compare. A day still filling
// counts, as the presets count it. Days before the answer's daily days
// count as having data when its first day has, since the rollup ran before
// it.
export function rollupReady(p: PreparedTrend, rollup: TrendRollup): boolean {
  if (rollup === "day") return true;
  const withData = new Set(p.dailyDays);
  const before = p.dailyDays[0] === p.dailyStart;
  const whole = (day: string) =>
    day < p.dailyStart ? before : withData.has(day);
  // The first day of the period after the last whole one, then back.
  const today = new Date(dayMs(p.end));
  let next =
    rollup === "week"
      ? dayMs(p.end) - ((today.getUTCDay() + 6) % 7) * DAY_MS
      : Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1);
  for (let k = 0; k < 2; k++) {
    const d = new Date(next - DAY_MS);
    const start =
      rollup === "week"
        ? next - 7 * DAY_MS
        : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    for (let ms = start; ms < next; ms += DAY_MS) {
      if (!whole(ymd(ms))) return false;
    }
    next = start;
  }
  return true;
}

// A run of periods, both ends included, as indexes into periods.
export interface PeriodRange {
  from: number;
  to: number;
}

// Whether every period of a range has data on each of its calendar days. A
// day still filling counts: it makes a range of several days read a few
// percent low, which the range's warning says.
export function isFull(p: PreparedTrend, r: PeriodRange): boolean {
  for (let i = r.from; i <= r.to; i++) {
    if (p.periodData[i] < p.periodDays[i]) return false;
  }
  return true;
}

// Whether a range's only day with data is still filling, as yesterday
// alone, or a week or month just begun. That day reads about a fifth low
// before the rollup's 00:30 UTC rerun and a few percent low until 03:30:
// among several days a warning, alone too far off, so a preset waits for
// it and the default passes it by.
export function isLoneFilling(p: PreparedTrend, r: PeriodRange): boolean {
  return rangeDays(p, r) === 1 && fillingIn(p, r).length === 1;
}

// Whether a period reads low: days without data, or a day still filling.
export function isPartial(p: PreparedTrend, i: number): boolean {
  return p.periodData[i] < p.periodDays[i] || p.periodFilling[i];
}

// The days still filling in a range, YYYY-MM-DD.
export function fillingIn(p: PreparedTrend, r: PeriodRange): string[] {
  const { from, to } = rangeDates(p, r);
  return p.fillingDays.filter((d) => d >= from && d <= to);
}

export function rangeDays(p: PreparedTrend, r: PeriodRange): number {
  let days = 0;
  for (let i = r.from; i <= r.to; i++) days += p.periodData[i];
  return days;
}

// A range's calendar days through yesterday: more than its days with data
// when days are missing.
export function rangeElapsed(p: PreparedTrend, r: PeriodRange): number {
  let days = 0;
  for (let i = r.from; i <= r.to; i++) days += p.periodElapsed[i];
  return days;
}

export function rangePushes(p: PreparedTrend, r: PeriodRange): number {
  let pushes = 0;
  for (let i = r.from; i <= r.to; i++) pushes += p.periodPushes[i];
  return pushes;
}

// What a range's sum is divided by: its days with data, or its pushes to
// main.
export function rangeDenominator(
  p: PreparedTrend,
  r: PeriodRange,
  per: TrendPer
): number {
  return per === "day" ? rangeDays(p, r) : rangePushes(p, r);
}

// A cell's runner-hours as a comparison per day or per commit counts them:
// all of them, or those of pushes to main.
function hoursOf(p: PreparedTrend, per: TrendPer): Float64Array {
  return per === "day" ? p.cellHours : p.cellMain;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// A day as the axis writes it, "Oct 28"; a month, "Oct", or "Jan 2027" in
// January, so a year's turn is said.
export function periodLabel(p: PreparedTrend, i: number): string {
  const d = new Date(dayMs(p.periods[i]));
  const month = MONTHS[d.getUTCMonth()];
  if (p.rollup === "month") {
    return d.getUTCMonth() === 0 ? `${month} ${d.getUTCFullYear()}` : month;
  }
  return `${month} ${d.getUTCDate()}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// A period as a bar's tooltip names it: a day with its weekday, "Thu Oct
// 22", so weekends' low bars read as weekends; a week or month as the axis
// writes it.
export function periodTitle(p: PreparedTrend, i: number): string {
  const label = periodLabel(p, i);
  if (p.rollup !== "day") return label;
  return `${WEEKDAYS[new Date(dayMs(p.periods[i])).getUTCDay()]} ${label}`;
}

// The periods the x axis labels: past 20 days, each Monday, so the labels
// mark whole weeks; otherwise every period up to 10, then every second,
// third and so on from the first.
export function axisPeriods(p: PreparedTrend): number[] {
  const n = p.periods.length;
  const all = p.periods.map((_, i) => i);
  if (p.rollup === "day" && n > 20) {
    return all.filter((i) => new Date(dayMs(p.periods[i])).getUTCDay() === 1);
  }
  const step = Math.max(1, Math.ceil(n / 10));
  return all.filter((i) => i % step === 0);
}

// A range's first and last day, YYYY-MM-DD, its last day yesterday at the
// latest: what GET /api/tests/cost/changes takes.
export function rangeDates(
  p: PreparedTrend,
  r: PeriodRange
): { from: string; to: string } {
  return {
    from: p.periods[r.from],
    to: ymd(dayMs(p.periods[r.to]) + (p.periodElapsed[r.to] - 1) * DAY_MS),
  };
}

// Days in words: "Nov 4", "Oct 28 – Nov 3".
export function daysLabel({ from, to }: { from: string; to: string }): string {
  const say = (day: string) => {
    const d = new Date(dayMs(day));
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  };
  return from === to ? say(from) : `${say(from)} – ${say(to)}`;
}

// A range's days in words, its last day yesterday at the latest.
export function rangeLabel(p: PreparedTrend, r: PeriodRange): string {
  return daysLabel(rangeDates(p, r));
}

// How many of a range's days with data fall on a weekend (UTC Saturday or
// Sunday), of how many, for the day rollup only: a week or a month holds
// both kinds in their usual mix.
export function weekendDays(
  p: PreparedTrend,
  r: PeriodRange
): { weekend: number; days: number } | null {
  if (p.rollup !== "day") return null;
  let weekend = 0;
  let days = 0;
  for (let i = r.from; i <= r.to; i++) {
    if (p.periodData[i] === 0) continue;
    days++;
    const weekday = new Date(dayMs(p.periods[i])).getUTCDay();
    if (weekday === 0 || weekday === 6) weekend++;
  }
  return { weekend, days };
}

// Whether A and B mix weekdays and weekend days differently enough, a
// quarter of their days or more, that weekends' fewer jobs would read as a
// change.
export function weekendMismatch(
  p: PreparedTrend,
  a: PeriodRange,
  b: PeriodRange
): boolean {
  const wa = weekendDays(p, a);
  const wb = weekendDays(p, b);
  if (wa === null || wb === null || wa.days === 0 || wb.days === 0) {
    return false;
  }
  return Math.abs(wa.weekend / wa.days - wb.weekend / wb.days) >= 0.25;
}

// Each label's $ per runner-hour from the file, null where it has none; 1
// for every label in runner-hours, so a cell's value is its hours times its
// label's factor either way.
function factors(p: PreparedTrend, rates: RatesFile | null): (number | null)[] {
  return p.labels.map((l) => (rates === null ? 1 : rateOf(rates, l)));
}

// A sum in the unit, with the runner-hours it is of and those with no rate.
export interface TrendTotals {
  value: number;
  runnerHours: number;
  unpriced: number;
}

export const zeroTotals = (): TrendTotals => ({
  value: 0,
  runnerHours: 0,
  unpriced: 0,
});

// Adds runner-hours at a label's factor ($ per runner-hour, 1 for hours),
// unpriced without one.
export function addHours(t: TrendTotals, hours: number, factor: number | null) {
  t.runnerHours += hours;
  if (factor === null) t.unpriced += hours;
  else t.value += hours * factor;
}

// Each period's value: every owner's, and the highlighted owners'; per day,
// each period's whole, per commit, its push:main value over its pushes.
export interface TrendSeries {
  unit: CostUnit;
  value: Float64Array;
  highlighted: Float64Array;
  runnerHours: Float64Array;
  unpriced: Float64Array;
}

export function trendSeries(
  p: PreparedTrend,
  rates: RatesFile | null,
  highlighted: ReadonlySet<string>,
  per: TrendPer = "day"
): TrendSeries {
  const f = factors(p, rates);
  const n = p.periods.length;
  const value = new Float64Array(n);
  const lit = new Float64Array(n);
  const runnerHours = new Float64Array(n);
  const unpriced = new Float64Array(n);
  const hours = hoursOf(p, per);
  for (let c = 0; c < hours.length; c++) {
    const i = p.cellPeriod[c];
    if (i < 0) continue;
    const h = hours[c];
    const factor = f[p.cellLabel[c]];
    runnerHours[i] += h;
    if (factor === null) {
      unpriced[i] += h;
      continue;
    }
    value[i] += h * factor;
    if (highlighted.has(p.owners[p.cellOwner[c]])) lit[i] += h * factor;
  }
  if (per === "commit") {
    for (let i = 0; i < n; i++) {
      const pushes = p.periodPushes[i];
      for (const a of [value, lit, runnerHours, unpriced]) {
        a[i] = pushes > 0 ? a[i] / pushes : 0;
      }
    }
  }
  return {
    unit: rates === null ? "hours" : "cost",
    value,
    highlighted: lit,
    runnerHours,
    unpriced,
  };
}

// A range's totals, of every owner or of some: all their runner-hours, or
// per commit, those of pushes to main.
export function rangeTotals(
  p: PreparedTrend,
  rates: RatesFile | null,
  r: PeriodRange,
  owners: ReadonlySet<string> | null = null,
  per: TrendPer = "day"
): TrendTotals {
  const f = factors(p, rates);
  const t = zeroTotals();
  const hours = hoursOf(p, per);
  for (let c = 0; c < hours.length; c++) {
    const i = p.cellPeriod[c];
    if (i < r.from || i > r.to) continue;
    if (owners !== null && !owners.has(p.owners[p.cellOwner[c]])) continue;
    addHours(t, hours[c], f[p.cellLabel[c]]);
  }
  return t;
}

// Two periods a reader compares, as a preset names them; available when
// every period of both has data on each of its days and neither is a lone
// day still filling. The days still filling it waits for, while they are
// all it lacks.
export interface TrendPreset {
  key: string;
  label: string;
  a: PeriodRange | null;
  b: PeriodRange | null;
  available: boolean;
  waitsFor: string[];
}

export function trendPresets(p: PreparedTrend): TrendPreset[] {
  const n = p.periods.length;
  const last = n - 1;
  // The last period every calendar day of which has passed.
  const lastWhole =
    n > 0 && p.periodElapsed[last] === p.periodDays[last] ? last : last - 1;
  const pair = (
    key: string,
    label: string,
    length: number,
    end: number,
    gap = length
  ): TrendPreset => {
    const b = { from: end - length + 1, to: end };
    const a = { from: b.from - gap, to: b.to - gap };
    const valid = a.from >= 0 && b.to <= last;
    const full = valid && isFull(p, a) && isFull(p, b);
    const lone = [a, b].filter((r) => valid && isLoneFilling(p, r));
    return {
      key,
      label,
      a: valid ? a : null,
      b: valid ? b : null,
      available: full && lone.length === 0,
      waitsFor: full ? lone.flatMap((r) => fillingIn(p, r)) : [],
    };
  };
  if (p.rollup === "day") {
    return [
      pair("day", "Yesterday vs same day last week", 1, last, 7),
      pair("7d", "Last 7 days vs prior 7", 7, last),
      pair("14d", "Last 14 days vs prior 14", 14, last),
    ];
  }
  if (p.rollup === "week") {
    return [
      pair("week", "Last week vs prior week", 1, lastWhole),
      pair("4w", "Last 4 weeks vs prior 4", 4, lastWhole),
    ];
  }
  return [
    pair("month", "Last month vs prior month", 1, lastWhole),
    pair("3m", "Last 3 months vs prior 3", 3, lastWhole),
  ];
}

// The periods compared at first: the longest preset available, else the
// last period with data against the one before it, passing by a lone day
// still filling.
export function defaultRanges(p: PreparedTrend): {
  a: PeriodRange | null;
  b: PeriodRange | null;
} {
  const preset = [...trendPresets(p)].reverse().find((x) => x.available);
  if (preset !== undefined) return { a: preset.a, b: preset.b };
  const withData = p.periods
    .map((_, i) => i)
    .filter(
      (i) => p.periodData[i] > 0 && !isLoneFilling(p, { from: i, to: i })
    );
  const b = withData[withData.length - 1];
  const a = withData[withData.length - 2];
  return {
    a: a === undefined ? null : { from: a, to: a },
    b: b === undefined ? null : { from: b, to: b },
  };
}

// The year a budget is read in, yesterday's (on January 1, the year just
// ended), and its calendar days.
export function trendYear(p: PreparedTrend): { year: number; days: number } {
  const year = new Date(dayMs(p.end) - DAY_MS).getUTCFullYear();
  return {
    year,
    days: (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY_MS,
  };
}

// B's pace: a value per day kept up for the year a budget is read in, and
// an average month, a twelfth of that year, so twelve months make the year.
export function trendPace(
  p: PreparedTrend,
  perDay: number
): { year: number; month: number } {
  const year = perDay * trendYear(p).days;
  return { year, month: year / 12 };
}

// Why a range's pace may mislead, in a few words, or null: weekends run far
// fewer jobs, so days with data and no weekend day read high, and mostly
// weekend days low. Counted over the range's days with data whatever the
// rollup, since the week or month through yesterday need not hold its
// usual mix; a range with a day still filling reads low, which its own
// warning says.
export function paceCaveat(p: PreparedTrend, r: PeriodRange): string | null {
  if (fillingIn(p, r).length > 0) return null;
  const { from, to } = rangeDates(p, r);
  const days = p.dailyDays.filter((d) => d >= from && d <= to && d < p.end);
  const weekend = days.filter((d) => {
    const weekday = new Date(dayMs(d)).getUTCDay();
    return weekday === 0 || weekday === 6;
  }).length;
  if (days.length === 0) return null;
  if (days.length === 1) {
    return weekend === 0
      ? "a weekday, so likely high"
      : "a weekend day, so likely low";
  }
  if (weekend === 0) return "all weekdays, so likely high";
  if (weekend === days.length) return "all weekend days, so likely low";
  if (2 * weekend > days.length) return "mostly weekend days, so likely low";
  return null;
}

// How many owners the trend's table names before "N more owners": fewer
// than the owner chart's, so what changed follows close behind.
export const TREND_TOP_OWNERS = 8;

// One row of the owners table: every owner together, an owner, the owners
// past the top folded, while they are listed the row that folds them back
// (no owners; its figures 0, or null without A), or a bucket of the hours
// no owner is given. Its figures are per day with data, or per commit
// (push:main runner-hours over pushes to main), as the table compares;
// change is B's against A's.
export interface TrendRow {
  key: string;
  label: string;
  owners: string[];
  kind: "all" | "owner" | "more" | "less" | "bucket";
  // The sums compared: all runner-hours, or per commit those of pushes to
  // main.
  a: TrendTotals | null;
  b: TrendTotals;
  aPer: number | null;
  bPer: number;
  // B's less A's, and that over A's; null without A, or for the change,
  // where A had none.
  delta: number | null;
  change: number | null;
  // B's share of every owner's B.
  share: number;
  // Per commit in A and in B, whichever the table compares by; null without
  // A or without pushes.
  aPerCommit: number | null;
  bPerCommit: number | null;
  // The row's value per day with data (or per commit) in each period.
  series: Float64Array;
  // With a budget for the row: $ a year, B's pace a year (per day,
  // whichever the table compares by) against it, and B's runner-hours with
  // no rate, which the pace leaves out: under the budget is then uncertain.
  budget: {
    annual: number;
    pace: number;
    ratio: number;
    unpriced: number;
  } | null;
}

// What the owners are sorted by, a column of the table: A or B per day (or
// per commit), the change, or the change in %; largest first, or smallest.
export const TREND_SORT_KEYS = ["a", "b", "delta", "change"] as const;
export type TrendSortKey = (typeof TREND_SORT_KEYS)[number];
export interface TrendSort {
  by: TrendSortKey;
  dir: "desc" | "asc";
}
export const DEFAULT_TREND_SORT: TrendSort = { by: "b", dir: "desc" };

// The sort after a click on a column's header, as the tests page's tables
// sort: the column largest first, or the other way round when it is the
// column sorted by.
export function nextTrendSort(sort: TrendSort, by: TrendSortKey): TrendSort {
  return sort.by === by
    ? { by, dir: sort.dir === "desc" ? "asc" : "desc" }
    : { by, dir: "desc" };
}

// The sort in force: by B while there is no A to compare against.
export function trendSortInForce(
  sort: TrendSort,
  a: PeriodRange | null
): TrendSort {
  return a === null && sort.by !== "b" ? DEFAULT_TREND_SORT : sort;
}

export function trendRows(
  p: PreparedTrend,
  rates: RatesFile | null,
  a: PeriodRange | null,
  b: PeriodRange,
  highlighted: ReadonlySet<string>,
  sort: TrendSort,
  expanded = false,
  top: number = TREND_TOP_OWNERS,
  per: TrendPer = "day"
): TrendRow[] {
  const f = factors(p, rates);
  const n = p.periods.length;
  const O = p.owners.length;
  const sums = () => Array.from({ length: O }, zeroTotals);
  // All runner-hours and those of pushes to main, in A and B.
  const [allA, allB, mainA, mainB] = [sums(), sums(), sums(), sums()];
  const series = Array.from({ length: O }, () => new Float64Array(n));
  for (let c = 0; c < p.cellHours.length; c++) {
    const i = p.cellPeriod[c];
    if (i < 0) continue;
    const o = p.cellOwner[c];
    const h = p.cellHours[c];
    const main = p.cellMain[c];
    const factor = f[p.cellLabel[c]];
    if (factor !== null) series[o][i] += (per === "day" ? h : main) * factor;
    if (i >= b.from && i <= b.to) {
      addHours(allB[o], h, factor);
      addHours(mainB[o], main, factor);
    }
    if (a !== null && i >= a.from && i <= a.to) {
      addHours(allA[o], h, factor);
      addHours(mainA[o], main, factor);
    }
  }
  const [inA, inB] = per === "day" ? [allA, allB] : [mainA, mainB];
  const aDays = a === null ? 0 : rangeDays(p, a);
  const bDays = rangeDays(p, b);
  const aPushes = a === null ? 0 : rangePushes(p, a);
  const bPushes = rangePushes(p, b);
  const [aDen, bDen] = per === "day" ? [aDays, bDays] : [aPushes, bPushes];
  const periodDen = per === "day" ? p.periodData : p.periodPushes;
  const dollars = rates !== null;
  const { days: inYear } = trendYear(p);
  const wholeB = inB.reduce((s, t) => s + t.value, 0);
  const row = (
    key: string,
    label: string,
    owners: number[],
    kind: TrendRow["kind"],
    annual: number | null
  ): TrendRow => {
    const sum = (ts: TrendTotals[]) =>
      owners.reduce((t, o) => {
        t.value += ts[o].value;
        t.runnerHours += ts[o].runnerHours;
        t.unpriced += ts[o].unpriced;
        return t;
      }, zeroTotals());
    const bt = sum(inB);
    const at = a === null ? null : sum(inA);
    const bPer = bDen > 0 ? bt.value / bDen : 0;
    const aPer = at === null || aDen === 0 ? null : at.value / aDen;
    const delta = aPer === null ? null : bPer - aPer;
    const s = new Float64Array(n);
    for (const o of owners) series[o].forEach((v, i) => (s[i] += v));
    for (let i = 0; i < n; i++)
      s[i] = periodDen[i] > 0 ? s[i] / periodDen[i] : 0;
    const allBt = sum(allB);
    const pace = (bDays > 0 ? allBt.value / bDays : 0) * inYear;
    return {
      key,
      label,
      owners: owners.map((o) => p.owners[o]),
      kind,
      a: at,
      b: bt,
      aPer,
      bPer,
      delta,
      change:
        delta === null || aPer === null || aPer === 0 ? null : delta / aPer,
      share: wholeB > 0 ? bt.value / wholeB : 0,
      aPerCommit:
        a === null || aPushes === 0 ? null : sum(mainA).value / aPushes,
      bPerCommit: bPushes === 0 ? null : sum(mainB).value / bPushes,
      series: s,
      budget:
        dollars && annual !== null
          ? {
              annual,
              pace,
              ratio: annual > 0 ? pace / annual : Infinity,
              unpriced: allBt.unpriced,
            }
          : null,
    };
  };
  const budget = rates?.budget ?? null;
  const ownerBudget = (owner: string) => budget?.owners[owner] ?? null;
  const ran = (o: number) => allA[o].runnerHours > 0 || allB[o].runnerHours > 0;
  const rows: TrendRow[] = [
    row(
      "all",
      "All owners",
      p.owners.map((_, o) => o),
      "all",
      budget?.annual ?? null
    ),
  ];
  const people = p.owners
    .map((name, o) => ({
      name,
      o,
      row: row(name, name, [o], "owner", ownerBudget(name)),
    }))
    .filter(({ name, o }) => !isBucket(name) && ran(o));
  // Rows without a value (no A, or a change in % from nothing) go last
  // either way.
  const { by, dir } = trendSortInForce(sort, a);
  const value = (r: TrendRow): number | null =>
    by === "a"
      ? r.aPer
      : by === "b"
      ? r.bPer
      : by === "delta"
      ? r.delta
      : r.change;
  people.sort((x, y) => {
    const vx = value(x.row);
    const vy = value(y.row);
    const order =
      vx === null || vy === null
        ? Number(vx === null) - Number(vy === null)
        : dir === "desc"
        ? vy - vx
        : vx - vy;
    return order || x.name.localeCompare(y.name);
  });
  // The owners past the top fold into one row, but never just one: a row
  // of one saves no room and hides a name. Highlighted owners keep their
  // rows wherever they rank. While every owner is listed, a last row folds
  // them back.
  const past = people.filter(
    ({ name }, i) => i >= top && !highlighted.has(name)
  ).length;
  const fold = past >= 2;
  const shown = people.filter(
    ({ name }, i) => !fold || expanded || i < top || highlighted.has(name)
  );
  rows.push(...shown.map((x) => x.row));
  const rest = people.filter((x) => !shown.includes(x));
  if (rest.length > 0) {
    rows.push(
      row(
        "more",
        `${rest.length} more owners`,
        rest.map((x) => x.o),
        "more",
        null
      )
    );
  } else if (fold) {
    rows.push(row("less", "Show fewer", [], "less", null));
  }
  for (const bucket of Object.keys(BUCKET_LABELS)) {
    const o = p.owners.indexOf(bucket);
    if (o >= 0 && ran(o)) {
      rows.push(
        row(bucket, BUCKET_LABELS[bucket], [o], "bucket", ownerBudget(bucket))
      );
    }
  }
  return rows;
}

// Every owner in the table's order, none folded, then the buckets: the
// Owner key's menu, and the order its ‹ and › keys step through.
export function trendOwnerOrder(
  p: PreparedTrend,
  rates: RatesFile | null,
  a: PeriodRange | null,
  b: PeriodRange,
  sort: TrendSort,
  per: TrendPer = "day"
): string[] {
  return trendRows(p, rates, a, b, new Set(), sort, true, Infinity, per)
    .filter((r) => r.kind === "owner" || r.kind === "bucket")
    .map((r) => r.owners[0]);
}

// The highlight a ‹ (-1) or › (1) key sets, stepping through the order from
// the first highlighted owner in it: the owner before or after it, one at a
// time. From every owner, › takes the first; from the first, ‹ goes back to
// every owner ([]). Null past either end.
export function ownerStep(
  order: readonly string[],
  highlighted: ReadonlySet<string>,
  step: 1 | -1
): string[] | null {
  const at = order.findIndex((o) => highlighted.has(o));
  if (step === 1) {
    const next = order[at + 1];
    return next === undefined ? null : [next];
  }
  if (at > 0) return [order[at - 1]];
  return highlighted.size > 0 ? [] : null;
}

// The year to date against the budget, from the daily totals: the $ on the
// days with data since January 1, the budget for those same days (its year
// spread evenly over the year's days), and B's pace a year against the
// year's budget. Days the rollup does not hold count against neither side.
export interface BudgetFacts {
  year: number;
  annual: number;
  ytd: number;
  ytdDays: number;
  ytdUnpriced: number;
  firstDay: string | null;
  toDate: number;
  ratio: number;
  pace: number | null;
}

export function budgetFacts(
  p: PreparedTrend,
  rates: RatesFile | null,
  b: PeriodRange | null
): BudgetFacts | null {
  const annual = rates?.budget?.annual ?? null;
  if (rates === null || annual === null) return null;
  const f = factors(p, rates);
  const { year, days: yearDays } = trendYear(p);
  const yearStart = ymd(Date.UTC(year, 0, 1));
  const inYear = p.dailyDays.map((d) => d >= yearStart && d < p.end);
  let ytd = 0;
  let ytdUnpriced = 0;
  for (let c = 0; c < p.dailyHours.length; c++) {
    if (!inYear[p.dailyDay[c]]) continue;
    const factor = f[p.dailyLabel[c]];
    if (factor === null) ytdUnpriced += p.dailyHours[c];
    else ytd += p.dailyHours[c] * factor;
  }
  const days = p.dailyDays.filter((_, d) => inYear[d]);
  const toDate = (annual * days.length) / yearDays;
  let pace: number | null = null;
  if (b !== null) {
    const bDays = rangeDays(p, b);
    if (bDays > 0) {
      pace = (rangeTotals(p, rates, b).value / bDays) * yearDays;
    }
  }
  return {
    year,
    annual,
    ytd,
    ytdDays: days.length,
    ytdUnpriced,
    firstDay: days[0] ?? null,
    toDate,
    ratio: toDate > 0 ? ytd / toDate : 0,
    pace,
  };
}

// The budget of some owners: the sum of theirs when every one has one.
export function ownersBudget(
  budget: RatesBudget | null,
  owners: readonly string[]
): number | null {
  if (budget === null || owners.length === 0) return null;
  let sum = 0;
  for (const o of owners) {
    const b = budget.owners[o];
    if (b === undefined) return null;
    sum += b;
  }
  return sum;
}

// A difference as the tables write it: "▲ +2 h", "▼ −$0.25", and "▼ <0.1 h"
// for a sliver, as changeLabel writes "▼ <1%"; amount labels the size.
export function deltaLabel(v: number, amount: (_v: number) => string): string {
  const size = amount(Math.abs(v));
  const sign = size.startsWith("<") ? "" : v > 0 ? "+" : "−";
  return `${v > 0 ? "▲" : "▼"} ${sign}${size}`;
}

// A change as the table writes it: "▲ +23%", "▼ −26%", "▲ <1%" for a
// sliver, "new" where A had none and B has some, "—" without A or either.
export function changeLabel(row: Pick<TrendRow, "change" | "delta">): string {
  if (row.delta === null || row.delta === 0) return "—";
  if (row.change === null) return row.delta > 0 ? "new" : "—";
  const pct = Math.abs(row.change * 100);
  const up = row.change > 0;
  if (pct < 1) return up ? "▲ <1%" : "▼ <1%";
  return up ? `▲ +${pct.toFixed(0)}%` : `▼ −${pct.toFixed(0)}%`;
}
