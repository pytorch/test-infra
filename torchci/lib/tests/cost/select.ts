import {
  addDays,
  type Compare,
  COMPARE_PRESETS,
  type ComparePreset,
  type Day,
  type DayRange,
  DEFAULT_PRESET,
  type Rollup,
  SHOW_OPTIONS,
  type TrendContext,
  type TrendsQuery,
} from "lib/api/tests/cost/contracts";
import type { CostTrend } from "lib/api/tests/cost/types";

// The Trends panel's A/B picker: whole bars of the
// rollup (days, Mon–Sun weeks, calendar months), the presets, the shown
// window, and a pure reducer for every gesture, so the panel only draws.
// Nothing here reads the clock: "today" is always TrendContext.end.

const DAY_MS = 86_400_000;
const ms = (day: Day) => Date.parse(`${day}T00:00:00Z`);
const ymd = (t: number): Day => new Date(t).toISOString().slice(0, 10);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Bars ──
export function barStart(rollup: Rollup, day: Day): Day {
  if (rollup === "day") return day;
  if (rollup === "week") {
    return addDays(day, -((new Date(ms(day)).getUTCDay() + 6) % 7));
  }
  return `${day.slice(0, 8)}01`;
}

export function barLast(rollup: Rollup, day: Day): Day {
  if (rollup === "day") return day;
  if (rollup === "week") return addDays(barStart("week", day), 6);
  const d = new Date(ms(day));
  return ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

// The first day of the bar n bars after the one holding day.
export function shiftBars(rollup: Rollup, day: Day, n: number): Day {
  if (rollup === "day") return addDays(day, n);
  if (rollup === "week") return addDays(barStart("week", day), 7 * n);
  const d = new Date(ms(day));
  return ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

// How many bars from the bar holding from to the bar holding to (0 for the
// same bar; negative when to is earlier).
export function barsBetween(rollup: Rollup, from: Day, to: Day): number {
  if (rollup === "day") return Math.round((ms(to) - ms(from)) / DAY_MS);
  if (rollup === "week") {
    return Math.round(
      (ms(barStart("week", to)) - ms(barStart("week", from))) / (7 * DAY_MS)
    );
  }
  const a = new Date(ms(from));
  const b = new Date(ms(to));
  return (
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    b.getUTCMonth() -
    a.getUTCMonth()
  );
}

export const barCount = (rollup: Rollup, r: DayRange): number =>
  barsBetween(rollup, r.from, r.to) + 1;

// Calendar days of the bar starting at start.
export function barDays(rollup: Rollup, start: Day): number {
  return Math.round((ms(barLast(rollup, start)) - ms(start)) / DAY_MS) + 1;
}

// A range snapped outward to whole bars, clipped at the last day (end − 1).
export function snapRange(rollup: Rollup, r: DayRange, last: Day): DayRange {
  const to = barLast(rollup, r.to);
  return { from: barStart(rollup, r.from), to: to > last ? last : to };
}

// Whether a range already sits on whole bars of the rollup (its end may be
// clipped at the last day).
export function isAligned(rollup: Rollup, r: DayRange, last: Day): boolean {
  return (
    barStart(rollup, r.from) === r.from &&
    (barLast(rollup, r.to) === r.to || r.to === last)
  );
}

export const sameRange = (x: DayRange | null, y: DayRange | null): boolean =>
  x !== null && y !== null && x.from === y.from && x.to === y.to;

const validRange = (r: DayRange | null | undefined): r is DayRange =>
  r !== null &&
  r !== undefined &&
  DAY_RE.test(r.from) &&
  DAY_RE.test(r.to) &&
  !Number.isNaN(ms(r.from)) &&
  !Number.isNaN(ms(r.to)) &&
  r.from <= r.to;

// ── Context, shown window ──
export function trendContext(answer: CostTrend): TrendContext {
  const end = answer.end;
  const sorted = answer.daily.days.filter((d) => d < end).sort();
  const days = new Set(sorted);
  const filling = new Set(
    (answer.daily.filling ?? []).filter((d) => days.has(d))
  );
  const y = addDays(end, -1);
  // L: the last complete day: yesterday, or the day before while yesterday is
  // still filling (or not in yet).
  const lastFull = days.has(y) && !filling.has(y) ? y : addDays(end, -2);
  return { end, firstDay: sorted[0] ?? null, lastFull, days, filling };
}

// The show window: from the first of the last `show` bars (the current,
// partial one included) to end − 1.
export function shownRange(rollup: Rollup, show: number, end: Day): DayRange {
  const last = addDays(end, -1);
  return {
    from: shiftBars(rollup, last, -(Math.max(1, Math.round(show)) - 1)),
    to: last,
  };
}

// The bars the chart draws: the show window from the first bar with data on
// (the data-start rule: no empty slots before the data). null without data.
export function visibleRange(
  rollup: Rollup,
  shown: DayRange,
  ctx: TrendContext
): DayRange | null {
  if (ctx.firstDay === null || ctx.firstDay > shown.to) return null;
  const first = barStart(rollup, ctx.firstDay);
  return { from: first > shown.from ? first : shown.from, to: shown.to };
}

// The smallest Show option whose window holds the period's first day, or
// null when none does.
export function fitShow(rollup: Rollup, r: DayRange, end: Day): number | null {
  return (
    SHOW_OPTIONS[rollup].find(
      (n) => shownRange(rollup, n, end).from <= r.from
    ) ?? null
  );
}

// ── Days with data in a range ──
export function dataDays(ctx: TrendContext, r: DayRange): number {
  let n = 0;
  for (let t = ms(r.from); t <= ms(r.to); t += DAY_MS) {
    if (ctx.days.has(ymd(t))) n++;
  }
  return n;
}

export function fillingDays(ctx: TrendContext, r: DayRange): Day[] {
  return [...ctx.filling].filter((d) => d >= r.from && d <= r.to).sort();
}

const isLoneFilling = (ctx: TrendContext, r: DayRange) =>
  dataDays(ctx, r) === 1 && fillingDays(ctx, r).length === 1;

const isFull = (ctx: TrendContext, r: DayRange) => {
  for (let t = ms(r.from); t <= ms(r.to); t += DAY_MS) {
    if (!ctx.days.has(ymd(t))) return false;
  }
  return true;
};

// ── Presets ──
export const PRESET_ROLLUP: Record<ComparePreset, Rollup> = {
  dod: "day",
  wow: "week",
  mom: "month",
  "7v7": "day",
  "28v28": "day",
};
export const PRESET_LABELS: Record<ComparePreset, string> = {
  dod: "Day over day",
  wow: "Week over week",
  mom: "Month over month",
  "7v7": "Last 7 vs prior 7",
  "28v28": "Last 28 vs prior 28",
};

// A preset's days, from L: DoD L−1 vs L; WoW and MoM the last two
// whole weeks or months through L; 7v7 and 28v28 rolling windows ending at L.
export function presetRanges(
  id: ComparePreset,
  ctx: TrendContext
): { a: DayRange; b: DayRange } {
  const L = ctx.lastFull;
  const back = (r: DayRange, n: number) => ({
    from: addDays(r.from, -n),
    to: addDays(r.to, -n),
  });
  switch (id) {
    case "dod":
      return { a: back({ from: L, to: L }, 1), b: { from: L, to: L } };
    case "7v7": {
      const b = { from: addDays(L, -6), to: L };
      return { a: back(b, 7), b };
    }
    case "28v28": {
      const b = { from: addDays(L, -27), to: L };
      return { a: back(b, 28), b };
    }
    case "wow": {
      const sunday =
        barLast("week", L) === L ? L : addDays(barStart("week", L), -1);
      const b = { from: addDays(sunday, -6), to: sunday };
      return { a: back(b, 7), b };
    }
    case "mom": {
      const lastDay =
        barLast("month", L) === L ? L : addDays(barStart("month", L), -1);
      const b = { from: barStart("month", lastDay), to: lastDay };
      const prior = addDays(b.from, -1);
      return { a: { from: barStart("month", prior), to: prior }, b };
    }
  }
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
// "Nov 4"; "Oct 28 – Nov 3"; "Nov 2 – 8" within one month.
export function dayLabel(day: Day): string {
  const d = new Date(ms(day));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
export function rangeText(r: DayRange, short = true): string {
  if (r.from === r.to) return dayLabel(r.from);
  if (short && r.from.slice(0, 7) === r.to.slice(0, 7)) {
    return `${dayLabel(r.from)} – ${Number(r.to.slice(8))}`;
  }
  return `${dayLabel(r.from)} – ${dayLabel(r.to)}`;
}

export interface PresetChoice {
  id: ComparePreset;
  label: string;
  rollup: Rollup;
  a: DayRange;
  b: DayRange;
  available: boolean;
  // One line for a disabled chip's tooltip, or A and B for an enabled one.
  title: string;
}

export function comparePresets(ctx: TrendContext): PresetChoice[] {
  return COMPARE_PRESETS.map((id) => {
    const { a, b } = presetRanges(id, ctx);
    const full = isFull(ctx, a) && isFull(ctx, b);
    const lone = [a, b].flatMap((r) =>
      isLoneFilling(ctx, r) ? fillingDays(ctx, r) : []
    );
    const available = full && lone.length === 0;
    let title = `A: ${rangeText(a)} · B: ${rangeText(b)}`;
    if (!available) {
      title =
        full && lone.length > 0
          ? `Waits for ${lone.map(dayLabel).join(", ")}, still filling`
          : `Needs ${rangeText({ from: a.from, to: b.to }, false)}; ${
              ctx.firstDay === null
                ? "no data yet"
                : `data starts ${dayLabel(ctx.firstDay)}`
            }`;
    }
    return {
      id,
      label: PRESET_LABELS[id],
      rollup: PRESET_ROLLUP[id],
      a,
      b,
      available,
      title,
    };
  });
}

// The preset whose rollup and (snapped) A and B these are, if any.
export function matchPreset(
  rollup: Rollup,
  a: DayRange,
  b: DayRange,
  ctx: TrendContext
): ComparePreset | null {
  const last = addDays(ctx.end, -1);
  for (const id of COMPARE_PRESETS) {
    if (PRESET_ROLLUP[id] !== rollup) continue;
    const r = presetRanges(id, ctx);
    if (
      sameRange(snapRange(rollup, r.a, last), a) &&
      sameRange(snapRange(rollup, r.b, last), b)
    ) {
      return id;
    }
  }
  return null;
}

// The last two bars with data (a bar whose only data day is still filling
// is passed by), B the later: the fallback when a rollup's default preset
// has no data (Month today: Oct vs Nov so far).
export function lastTwoBars(
  rollup: Rollup,
  ctx: TrendContext
): { a: DayRange; b: DayRange } | null {
  if (ctx.firstDay === null) return null;
  const last = addDays(ctx.end, -1);
  const found: DayRange[] = [];
  for (
    let start = barStart(rollup, last);
    start >= barStart(rollup, ctx.firstDay) && found.length < 2;
    start = shiftBars(rollup, start, -1)
  ) {
    const r = snapRange(rollup, { from: start, to: start }, last);
    if (dataDays(ctx, r) > 0 && !isLoneFilling(ctx, r)) found.push(r);
  }
  return found.length === 2 ? { a: found[1], b: found[0] } : null;
}

// A rollup's default compare: its preset, or the last two bars with data.
function defaultRanges(rollup: Rollup, ctx: TrendContext) {
  const id = DEFAULT_PRESET[rollup];
  const preset = comparePresets(ctx).find((p) => p.id === id)!;
  if (preset.available) return { a: preset.a, b: preset.b };
  return lastTwoBars(rollup, ctx) ?? { a: preset.a, b: preset.b };
}

// The URL's compare, read against the answer: a/b win over cmp (a lone a or
// b keeps its side, the other its neighbour of the same length unless cmp
// names it); snapped outward to whole bars and clipped only after
// end − 1, so days before the data stay (the no-data chip says so).
// Malformed falls back to the rollup default.
export function resolveCompare(
  q: TrendsQuery,
  ctx: TrendContext
): Compare | null {
  const last = addDays(ctx.end, -1);
  const fix = (r: DayRange | null | undefined): DayRange | null => {
    if (!validRange(r) || r.from > last) return null;
    return snapRange(q.rollup, r, last);
  };
  let a = fix(q.a);
  let b = fix(q.b);
  // A lone a or b without cmp: the other side is the same number of bars
  // just before B (or just after A), so it never lands on the given side.
  if (q.cmp === null && (a === null) !== (b === null)) {
    const given = (a ?? b) as DayRange;
    const n = barsBetween(q.rollup, given.from, given.to) + 1;
    const dir = a === null ? -n : n;
    const from = shiftBars(q.rollup, given.from, dir);
    const other = fix({
      from,
      to: barLast(q.rollup, shiftBars(q.rollup, from, n - 1)),
    });
    if (a === null) a = other;
    else b = other;
  }
  if (a === null || b === null) {
    const r =
      q.cmp !== null && (COMPARE_PRESETS as readonly string[]).includes(q.cmp)
        ? presetRanges(q.cmp, ctx)
        : defaultRanges(q.rollup, ctx);
    a = a ?? fix(r.a);
    b = b ?? fix(r.b);
  }
  if (a === null || b === null) return null;
  return { rollup: q.rollup, a, b, preset: matchPreset(q.rollup, a, b, ctx) };
}

// ── The reducer ──
export type Side = "a" | "b";
export const SIDES: readonly Side[] = ["a", "b"];

export interface Selection {
  rollup: Rollup;
  a: DayRange;
  b: DayRange;
  preset: ComparePreset | null;
}
export interface Picker {
  sel: Selection;
  armed: Side;
}

// What gestures may reach: the bars drawn, first bar start to end − 1.
export interface PickEnv {
  window: DayRange;
  ctx: TrendContext;
}

export type PickAction =
  | { type: "arm"; side: Side }
  | { type: "place"; side: Side; at: Day }
  | { type: "draw"; side: Side; from: Day; to: Day }
  | { type: "stretch"; side: Side; edge: "from" | "to"; at: Day }
  | { type: "slide"; side: Side; by: number }
  | { type: "move"; by: number; whole?: boolean }
  | { type: "resize"; by: number }
  | { type: "swap" }
  | { type: "preset"; id: ComparePreset }
  | { type: "rollup"; rollup: Rollup };

export function pickerOf(compare: Compare, armed: Side = "b"): Picker {
  return {
    sel: {
      rollup: compare.rollup,
      a: compare.a,
      b: compare.b,
      preset: compare.preset,
    },
    armed,
  };
}

const sameSel = (x: Selection, y: Selection) =>
  x.rollup === y.rollup &&
  sameRange(x.a, y.a) &&
  sameRange(x.b, y.b) &&
  x.preset === y.preset;

function commit(p: Picker, sel: Selection): Picker {
  if (sameSel(p.sel, sel)) return p;
  return { ...p, sel };
}

export function reducePicker(
  p: Picker,
  action: PickAction,
  env: PickEnv
): Picker {
  const { rollup } = p.sel;
  const last = env.window.to;
  const v0 = barStart(rollup, env.window.from);
  const n = barsBetween(rollup, v0, last) + 1; // bars drawn
  const off = (day: Day) => barsBetween(rollup, v0, day);
  const clamp = (i: number) => Math.max(0, Math.min(n - 1, i));
  const range = (s: number, e: number): DayRange => {
    const to = barLast(rollup, shiftBars(rollup, v0, e));
    return { from: shiftBars(rollup, v0, s), to: to > last ? last : to };
  };
  // A gesture that leaves the period where it sits changes nothing.
  const withSide = (side: Side, r: DayRange) =>
    sameRange(p.sel[side], r)
      ? p
      : commit(p, { ...p.sel, [side]: r, preset: null });
  // A period of len bars starting at bar s, kept inside the window.
  const at = (s: number, len: number) => {
    const start = Math.max(0, Math.min(n - len, s));
    return range(start, Math.min(n - 1, start + len - 1));
  };

  switch (action.type) {
    case "arm":
      return p.armed === action.side ? p : { ...p, armed: action.side };
    case "place": {
      const r = p.sel[action.side];
      return withSide(action.side, at(off(action.at), barCount(rollup, r)));
    }
    case "draw": {
      const x = clamp(off(action.from));
      const y = clamp(off(action.to));
      return withSide(action.side, range(Math.min(x, y), Math.max(x, y)));
    }
    case "stretch": {
      const r = p.sel[action.side];
      const s = off(r.from);
      const e = off(r.to);
      const i = clamp(off(action.at));
      return withSide(
        action.side,
        action.edge === "from"
          ? range(Math.min(i, e), e)
          : range(s, Math.max(i, s))
      );
    }
    case "slide": {
      const r = p.sel[action.side];
      return withSide(
        action.side,
        at(off(r.from) + action.by, barCount(rollup, r))
      );
    }
    case "move": {
      const r = p.sel[p.armed];
      const len = barCount(rollup, r);
      const step = action.whole ? len : 1;
      return withSide(p.armed, at(off(r.from) + action.by * step, len));
    }
    case "resize": {
      const r = p.sel[p.armed];
      const s = off(r.from);
      const e = off(r.to);
      if (action.by > 0) {
        // ] grows at the end, or at the start once the end is at the right
        // edge.
        if (e + 1 <= n - 1) return withSide(p.armed, range(s, e + 1));
        return s > 0 ? withSide(p.armed, range(s - 1, e)) : p;
      }
      return e - 1 >= s ? withSide(p.armed, range(s, e - 1)) : p;
    }
    case "swap":
      return commit(p, { ...p.sel, a: p.sel.b, b: p.sel.a, preset: null });
    case "preset": {
      const id = action.id;
      const to = PRESET_ROLLUP[id];
      const r = presetRanges(id, env.ctx);
      const end1 = addDays(env.ctx.end, -1);
      return commit(p, {
        rollup: to,
        a: snapRange(to, r.a, end1),
        b: snapRange(to, r.b, end1),
        preset: id,
      });
    }
    case "rollup": {
      const to = action.rollup;
      if (to === rollup) return p;
      const end1 = addDays(env.ctx.end, -1);
      if (isAligned(to, p.sel.a, end1) && isAligned(to, p.sel.b, end1)) {
        return commit(p, {
          rollup: to,
          a: p.sel.a,
          b: p.sel.b,
          preset: matchPreset(to, p.sel.a, p.sel.b, env.ctx),
        });
      }
      const r = defaultRanges(to, env.ctx);
      const a = snapRange(to, r.a, end1);
      const b = snapRange(to, r.b, end1);
      return commit(p, {
        rollup: to,
        a,
        b,
        preset: matchPreset(to, a, b, env.ctx),
      });
    }
  }
}

// A press that moves less than this is a click (a jittery click places).
export const DRAG_PX = 4;

// What a click at a bar would place for a side (the ghost), or null where
// the period already sits.
export function ghostFor(
  p: Picker,
  side: Side,
  at: Day,
  env: PickEnv
): DayRange | null {
  const next = reducePicker(p, { type: "place", side, at }, env);
  return next === p ? null : next.sel[side];
}

// The URL patch a selection writes: a preset writes only cmp (relative, so a
// bookmarked WoW stays current), anything else only a and b (absolute).
export function selectionPatch(
  sel: Selection,
  ctx: TrendContext
): Pick<TrendsQuery, "rollup" | "cmp" | "a" | "b"> {
  if (sel.preset !== null) {
    const r = presetRanges(sel.preset, ctx);
    const last = addDays(ctx.end, -1);
    if (
      PRESET_ROLLUP[sel.preset] === sel.rollup &&
      sameRange(snapRange(sel.rollup, r.a, last), sel.a) &&
      sameRange(snapRange(sel.rollup, r.b, last), sel.b)
    ) {
      return { rollup: sel.rollup, cmp: sel.preset, a: null, b: null };
    }
  }
  return { rollup: sel.rollup, cmp: null, a: sel.a, b: sel.b };
}

// ── Words ──
const UNIT_WORDS: Record<Rollup, string> = {
  day: "day",
  week: "week",
  month: "month",
};
export const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

// A period's length in bars of the rollup: "1 day", "7 days", "1 week".
export const lengthText = (rollup: Rollup, r: DayRange) =>
  plural(barCount(rollup, r), UNIT_WORDS[rollup]);

// Calendar days of a period's whole bars (a current bar counts all its days).
export function calendarDays(rollup: Rollup, r: DayRange): number {
  return (
    Math.round(
      (ms(barLast(rollup, r.to)) - ms(barStart(rollup, r.from))) / DAY_MS
    ) + 1
  );
}

// Weekend days among a range's days with data, and how many days with data.
export function weekendShare(
  ctx: TrendContext,
  r: DayRange
): { weekend: number; days: number } {
  let weekend = 0;
  let days = 0;
  for (let t = ms(r.from); t <= ms(r.to); t += DAY_MS) {
    if (!ctx.days.has(ymd(t))) continue;
    days++;
    const w = new Date(t).getUTCDay();
    if (w === 0 || w === 6) weekend++;
  }
  return { weekend, days };
}

// Days A and B share (0 when apart).
export function overlapDays(a: DayRange, b: DayRange): number {
  const from = a.from > b.from ? a.from : b.from;
  const to = a.to < b.to ? a.to : b.to;
  return from > to ? 0 : Math.round((ms(to) - ms(from)) / DAY_MS) + 1;
}
