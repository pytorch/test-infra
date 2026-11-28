import {
  addDays,
  type CostSeries,
  type Day,
  type DayRange,
  type Rollup,
  type TrendContext,
} from "lib/api/tests/cost/contracts";
import type { CostTrend } from "lib/api/tests/cost/types";
import {
  barDays,
  barLast,
  barStart,
  shiftBars,
  visibleRange,
} from "lib/tests/cost/select";

// Day cells folded into the chart's bars: the page asks
// /trend for days only (or /series for a scope), and weeks and months are
// summed here, so every bar and A/B is priced per day and a rollup switch
// needs no refetch. Each cell keeps its day for pricing.

export interface DayCells {
  days: Day[]; // days with data, ascending: the per-day divisor
  pushes: number[]; // pushes to main, aligned with days
  filling: ReadonlySet<Day>;
  keys: string[]; // owners (/trend) or children (/series; "" = the rest)
  labels: string[];
  cellDay: Int32Array; // index into days
  cellKey: Int32Array;
  cellLabel: Int32Array;
  cellH: Float64Array;
  cellMain: Float64Array; // push:main hours, part of cellH
}

function cellsOf(
  days: Day[],
  pushes: number[],
  filling: readonly Day[],
  keys: string[],
  labels: string[],
  rows: readonly (readonly number[])[],
  dayOf: (_row: readonly number[]) => Day | undefined
): DayCells {
  const order = days.map((d, i) => [d, pushes[i] ?? 0] as const);
  const index = new Map(order.map(([d], i) => [d, i]));
  // A cell on a day the days list lacks still counts (with no pushes).
  for (const row of rows) {
    const d = dayOf(row);
    if (d !== undefined && !index.has(d)) {
      index.set(d, -1);
      order.push([d, 0]);
    }
  }
  order.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  order.forEach(([d], i) => index.set(d, i));
  const n = rows.length;
  const cells: DayCells = {
    days: order.map(([d]) => d),
    pushes: order.map(([, p]) => p),
    filling: new Set(filling),
    keys,
    labels,
    cellDay: new Int32Array(n),
    cellKey: new Int32Array(n),
    cellLabel: new Int32Array(n),
    cellH: new Float64Array(n),
    cellMain: new Float64Array(n),
  };
  rows.forEach((row, c) => {
    const d = dayOf(row);
    cells.cellDay[c] = d === undefined ? -1 : index.get(d)!;
  });
  return cells;
}

// /trend?rollup=day: [period, owner, label, h, mainH], a period being a day.
export function trendDayCells(t: CostTrend): DayCells {
  if (t.rollup !== "day") throw new Error("trendDayCells needs rollup=day");
  const cells = cellsOf(
    t.daily.days,
    t.daily.pushes ?? [],
    t.daily.filling ?? [],
    t.owners,
    t.labels,
    t.cells,
    (row) => t.periods[row[0]]
  );
  t.cells.forEach(([, o, l, h, main], c) => {
    cells.cellKey[c] = o;
    cells.cellLabel[c] = l;
    cells.cellH[c] = h;
    cells.cellMain[c] = main ?? 0;
  });
  return cells;
}

// /series: [day, child, label, h, mainH].
export function seriesDayCells(s: CostSeries): DayCells {
  const cells = cellsOf(
    s.days,
    s.pushes,
    s.filling,
    s.children,
    s.labels,
    s.cells,
    (row) => s.days[row[0]]
  );
  s.cells.forEach(([, k, l, h, main], c) => {
    cells.cellKey[c] = k;
    cells.cellLabel[c] = l;
    cells.cellH[c] = h;
    cells.cellMain[c] = main;
  });
  return cells;
}

export interface Bar {
  start: Day;
  last: Day; // the bar's last calendar day
  calendar: number; // calendar days
  elapsed: number; // calendar days through end − 1
  data: number; // days with data
  pushes: number; // pushes to main on those days
  filling: boolean; // holds a day still filling
}

export interface Folded {
  rollup: Rollup;
  end: Day;
  shown: DayRange; // the Show window
  window: DayRange | null; // what is drawn: from the first bar with data (null: none)
  dataStart: Day | null;
  bars: Bar[];
  cells: DayCells;
  cellBar: Int32Array; // -1 outside the drawn bars
  dayBar: Int32Array; // cells.days → bar, -1 outside
  // Cells grouped by bar: barCells[barStart[i]..barStart[i + 1]).
  barCells: Int32Array;
  barOffsets: Int32Array;
}

export function foldBars(
  cells: DayCells,
  rollup: Rollup,
  shown: DayRange,
  ctx: TrendContext
): Folded {
  const window = visibleRange(rollup, shown, ctx);
  const bars: Bar[] = [];
  const last = addDays(ctx.end, -1);
  if (window !== null) {
    for (
      let start = barStart(rollup, window.from);
      start <= window.to;
      start = shiftBars(rollup, start, 1)
    ) {
      const end = barLast(rollup, start);
      const calendar = barDays(rollup, start);
      const elapsed =
        end <= last
          ? calendar
          : Math.round(
              (Date.parse(`${last}T00:00:00Z`) -
                Date.parse(`${start}T00:00:00Z`)) /
                86_400_000
            ) + 1;
      bars.push({
        start,
        last: end,
        calendar,
        elapsed,
        data: 0,
        pushes: 0,
        filling: false,
      });
    }
  }
  const barIndex = (day: Day): number => {
    if (window === null || day < window.from || day > window.to) return -1;
    // Bars are few (≤ 400): binary search on starts.
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].start <= day) lo = mid;
      else hi = mid - 1;
    }
    return day <= bars[lo].last ? lo : -1;
  };
  const dayBar = new Int32Array(cells.days.length);
  cells.days.forEach((d, i) => {
    const b = barIndex(d);
    dayBar[i] = b;
    if (b < 0) return;
    bars[b].data++;
    bars[b].pushes += cells.pushes[i] ?? 0;
    if (cells.filling.has(d)) bars[b].filling = true;
  });
  const n = cells.cellH.length;
  const cellBar = new Int32Array(n);
  const counts = new Int32Array(bars.length + 1);
  for (let c = 0; c < n; c++) {
    const d = cells.cellDay[c];
    const b = d < 0 ? -1 : dayBar[d];
    cellBar[c] = b;
    if (b >= 0) counts[b + 1]++;
  }
  const barOffsets = new Int32Array(bars.length + 1);
  for (let b = 0; b < bars.length; b++) {
    barOffsets[b + 1] = barOffsets[b] + counts[b + 1];
  }
  const fill = barOffsets.slice(0, bars.length);
  const barCells = new Int32Array(barOffsets[bars.length]);
  for (let c = 0; c < n; c++) {
    const b = cellBar[c];
    if (b >= 0) barCells[fill[b]++] = c;
  }
  return {
    rollup,
    end: ctx.end,
    shown,
    window,
    dataStart: ctx.firstDay,
    bars,
    cells,
    cellBar,
    dayBar,
    barCells,
    barOffsets,
  };
}

// "4 of 7 days" for a bar with fewer days with data than calendar days (the
// current bar: "3 of 7 days so far"); null for a whole bar.
export function daysNote(bar: Bar): string | null {
  if (bar.calendar === 1) return null;
  if (bar.data >= bar.calendar) return null;
  return `${bar.data} of ${bar.calendar} days${
    bar.elapsed < bar.calendar ? " so far" : ""
  }`;
}

// Whether a bar reads low or partial: days without data, or a day filling.
export const isPartialBar = (bar: Bar): boolean =>
  bar.data < bar.calendar || bar.filling;

// What a side's Total divides by: the bars of the rollup it touches that
// count at least one day (days with data in hours, priced days in $), each as
// one whole bar. Day: its counted days (per day); a whole week or month: 1
// (its total); two weeks: 2 (their average week). A partial bar counts as a
// whole one, so it reads naturally lower, as its bar does; a bar with nothing
// counted (no data, or no rates in $) is unknown and left out.
export function rollupUnits(rollup: Rollup, counted: readonly Day[]): number {
  return new Set(counted.map((day) => barStart(rollup, day))).size;
}

// The Total's unit in words: "a day", "a week", "a month".
export const rollupWord = (rollup: Rollup): string => `a ${rollup}`;
