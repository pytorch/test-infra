import {
  childBy,
  type CostCases,
  type CostScope,
  costUnit,
  type Day,
  type DayRange,
  daysIn,
  type Dim,
  type DrillQuery,
  type Per,
  type Pill,
  type Pricer,
  type Rollup,
  type ScopeBy,
  type ScopeChildInfo,
  type Unit,
  UNKNOWN_MACHINE,
} from "lib/api/tests/cost/contracts";
import type { CostTrend } from "lib/api/tests/cost/types";
import { testsPagePath } from "lib/api/tests/pages/parameters";
import type { EnvironmentRecord, EnvVarsRecord } from "lib/api/tests/types";
import { rollupUnits, rollupWord } from "lib/tests/cost/fold";
import { fineAmountLabel } from "lib/tests/cost/query";
import { pricedDays, pricingNotes } from "lib/tests/cost/ratePeriods";
import { isBucket, ownerLabel } from "lib/tests/cost/runnerHours";
import { niceTicks } from "lib/tests/cost/ticks";
import { configToken, environmentTokens } from "lib/tests/environment";
import type { NameFilter, TestsFacet } from "lib/tests/facets";

// The drill-down: the scope
// trail, its levels' rows and scales, the change sentence and the test level,
// as pure functions of /scope and /cases answers. The components only draw
// what these return.

// ── Constants ──
// Rows under these on both sides are hidden, and a pill whose scope
// falls under them on both sides is dropped.
export const HIDE_PER_DAY = 0.05;
export const HIDE_PER_COMMIT = 0.005;
// Top-N cut per level; lanes and runner labels list every row.
export const TOP_N: Record<ScopeBy, number> = {
  o: 12,
  m: 12,
  f: 15,
  lane: Infinity,
  label: Infinity,
};
// % is capped for the bar and for ranking; the text keeps the truth.
export const PCT_CAP = 2;
// The smaller side of the change column keeps at least this share.
export const CHANGE_MIN_SIDE = 0.16;
// Within this share of the track, A and B read as the same: B only.
export const SAME_TRACK = 0.002;
// Cases shown at first and per "Show more".
export const CASES_PAGE = 12;

// ── Trail ──
// A file pill needs an owner or a machine before it. Structural, so it
// needs no answer.
export function structuralTrail(trail: readonly Pill[]): Pill[] {
  const out: Pill[] = [];
  for (const pill of trail) {
    if (pill.dim === "f" && !out.some((p) => p.dim === "o" || p.dim === "m")) {
      break;
    }
    out.push(pill);
  }
  return out;
}

// A scope's figures in hours per day on each side, null for a side without
// days: what validity reads.
function perDayHours(level: CostScope, child: string): [number, number] {
  const c = level.children.indexOf(child);
  const sums = [0, 0];
  if (c >= 0) {
    for (const [side, , ch, , h] of level.cells) {
      if (ch === c) sums[side] += h;
    }
  }
  return [
    sums[0] / Math.max(1, level.sides[0].days.length),
    sums[1] / Math.max(1, level.sides[1].days.length),
  ];
}

// The trail with its first dead pill and every pill after it
// dropped, or null for no change. levels[k] is the current answer of
// /scope(trail[0..k), by = trail[k].dim), undefined while it loads or when the
// answer in hand is a kept one. It acts only when every level up to the first
// failing pill is current and both of that level's sides have days, so a
// loading level, a stale echo or a side before the data never drops a pill.
// It never consults the 7-day answer.
export function validTrail(
  trail: Pill[],
  levels: (CostScope | undefined)[]
): Pill[] | null {
  const structural = structuralTrail(trail);
  const base = structural.length < trail.length ? structural : trail;
  for (let k = 0; k < base.length; k++) {
    const level = levels[k];
    if (level === undefined) break;
    if (level.sides[0].days.length === 0 || level.sides[1].days.length === 0) {
      break;
    }
    const [a, b] = perDayHours(level, base[k].value);
    if (a < HIDE_PER_DAY && b < HIDE_PER_DAY) return base.slice(0, k);
  }
  return base === trail ? null : base;
}

// The pill name click: keep pills 0..k. k = -1 is the root.
export function climbTo(trail: readonly Pill[], k: number): Pill[] {
  return trail.slice(0, k + 1);
}

// ✕ on pill k: drop it, keep the rest (inductor › avx512 ✕inductor → avx512
// on all owners; o › m › f ✕m → o › f).
export function dropPill(trail: readonly Pill[], k: number): Pill[] {
  return structuralTrail(trail.filter((_, i) => i !== k));
}

// ⇄ between pill k and k + 1, offered between adjacent owner and machine pills.
export function canFlip(trail: readonly Pill[], k: number): boolean {
  const a = trail[k];
  const b = trail[k + 1];
  return (
    a !== undefined &&
    b !== undefined &&
    ((a.dim === "o" && b.dim === "m") || (a.dim === "m" && b.dim === "o"))
  );
}

export function flipPills(trail: readonly Pill[], k: number): Pill[] {
  if (!canFlip(trail, k)) return [...trail];
  const out = [...trail];
  [out[k], out[k + 1]] = [out[k + 1], out[k]];
  return out;
}

// ▾ click on pill k: swap the sibling in and keep the deeper pills; validity
// drops them later if the new scope has no hours in them.
export function swapPill(
  trail: readonly Pill[],
  k: number,
  value: string
): Pill[] {
  return trail.map((p, i) => (i === k ? { dim: p.dim, value } : p));
}

// A row of the canvas, or a pick from "+ next": append it.
export function appendPill(trail: readonly Pill[], pill: Pill): Pill[] {
  return structuralTrail([...trail.filter((p) => p.dim !== pill.dim), pill]);
}

// The root ▾: the first level lists owners or machines. With a pill of that
// dimension pinned, it moves to the front (same scope, the table's siblings
// change); without one, the trail starts over at that root.
export function chooseRoot(
  trail: readonly Pill[],
  root: "o" | "m"
): { trail: Pill[]; root: "o" | "m" } {
  if (trail.length === 0) return { trail: [], root };
  if (trail[0].dim === root) return { trail: [...trail], root };
  const at = trail.findIndex((p) => p.dim === root);
  if (at < 0) return { trail: [], root };
  const pill = trail[at];
  return {
    trail: structuralTrail([pill, ...trail.filter((_, i) => i !== at)]),
    root,
  };
}

// What "+ next" adds: the canvas's dimension when it is a pill's. Lanes
// and runner labels are terminal.
export function nextDim(trail: readonly Pill[], root: "o" | "m"): Dim | null {
  const by = childBy(trail, root);
  return by === "o" || by === "m" || by === "f" ? by : null;
}

// ── Names ──
const NOUNS: Record<ScopeBy, [string, string]> = {
  o: ["owner", "owners"],
  m: ["machine", "machines"],
  f: ["test file", "test files"],
  lane: ["environment", "environments"],
  label: ["runner label", "runner labels"],
};
export function byNoun(by: ScopeBy, plural = false): string {
  return NOUNS[by][plural ? 1 : 0];
}
export function byTitle(by: ScopeBy): string {
  const noun = NOUNS[by][1];
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

export function fileShort(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}
export function workflowShort(path: string): string {
  return fileShort(path).replace(/\.ya?ml$/, "");
}

// A pill's value as the page writes it.
export function pillName(pill: Pill): string {
  if (pill.dim === "o") return ownerLabel(pill.value);
  if (pill.dim === "f") return fileShort(pill.value);
  return pill.value;
}

// A child of an answer as its row names it: owners with their bucket names,
// files by their last segment, a lane by its environment's tokens, a runner
// label with its workflow.
export function childName(
  by: ScopeBy,
  child: string,
  info: ScopeChildInfo | undefined
): { name: string; detail: string } {
  switch (by) {
    case "o":
      return { name: ownerLabel(child), detail: "" };
    case "m":
      return { name: child, detail: "" };
    case "f": {
      const at = child.lastIndexOf("/");
      return {
        name: fileShort(child),
        detail: at < 0 ? "" : child.slice(0, at + 1),
      };
    }
    case "lane": {
      const workflow = info?.workflow ?? child.split("|")[1] ?? "";
      return {
        name: info?.environment
          ? environmentText(info.environment)
          : `environment ${child.split("|")[0]}`,
        detail: workflow === "" ? "" : workflowShort(workflow),
      };
    }
    case "label": {
      const [label, workflow = ""] = child.split("|");
      return {
        name: info?.label ?? label,
        detail: workflowShort(info?.workflow ?? workflow),
      };
    }
  }
}

export function isBucketChild(by: ScopeBy, child: string): boolean {
  return (
    (by === "o" && isBucket(child)) || (by === "m" && child === UNKNOWN_MACHINE)
  );
}

// The catalog's spellings as the tests page labels them, for the first word
// of a token (the page has no options here).
const TOKEN_LABELS: Record<string, string> = {
  cpu: "CPU",
  cuda: "CUDA",
  rocm: "ROCm",
  xpu: "XPU",
  mps: "MPS",
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
  gcc: "GCC",
  clang: "Clang",
  msvc: "MSVC",
};
// An environment as one line of tokens: "CUDA 13.2 · NVIDIA L4 · Python 3.11 ·
// Linux 22.04 · x86_64 avx2 · GCC 11.4".
export function environmentTokenTexts(
  environment: EnvironmentRecord
): string[] {
  const { primary, secondary } = environmentTokens(environment, undefined);
  return [...primary, ...secondary].map((t) => {
    const [first, ...rest] = t.text.split(" ");
    return [TOKEN_LABELS[first] ?? first, ...rest].join(" ");
  });
}
export function environmentText(environment: EnvironmentRecord): string {
  return environmentTokenTexts(environment).join(" · ");
}

// Tokens every environment shares, lifted into one line above the lanes.
export function commonTokens(
  environments: readonly EnvironmentRecord[]
): string[] {
  if (environments.length < 2) return [];
  const lists = environments.map(environmentTokenTexts);
  return lists[0].filter((t) => lists.every((l) => l.includes(t)));
}

// The scope's name in a sentence: "inductor on Linux x86_64 avx512",
// "test_flex_attention.py of inductor on Linux x86_64 avx512".
export function scopeName(trail: readonly Pill[], root: "o" | "m"): string {
  if (trail.length === 0) return root === "m" ? "All machines" : "All owners";
  const o = trail.find((p) => p.dim === "o");
  const m = trail.find((p) => p.dim === "m");
  const f = trail.find((p) => p.dim === "f");
  const parts: string[] = [];
  if (f) parts.push(pillName(f));
  if (o) parts.push(f ? `of ${pillName(o)}` : pillName(o));
  if (m) parts.push(f || o ? `on ${pillName(m)}` : pillName(m));
  return parts.join(" ");
}

// The head's title (the last pill) and its context (the ancestors).
export function scopeTitle(
  trail: readonly Pill[],
  root: "o" | "m"
): { title: string; context: string } {
  if (trail.length === 0) {
    return {
      title: root === "m" ? "All machines" : "All owners",
      context: "test jobs",
    };
  }
  const last = trail[trail.length - 1];
  const before = trail.slice(0, -1);
  return {
    title: pillName(last),
    context: before.length === 0 ? "" : `in ${scopeName(before, root)}`,
  };
}

// The parent scope's name for "Share of …" and the table's total row.
export function parentName(trail: readonly Pill[], root: "o" | "m"): string {
  const parent = trail.slice(0, -1);
  return parent.length === 0 ? "all test jobs" : scopeName(parent, root);
}
export function totalRowName(trail: readonly Pill[], root: "o" | "m"): string {
  const parent = trail.slice(0, -1);
  return parent.length === 0
    ? scopeName([], rootOfTrail(trail, root))
    : `All of ${scopeName(parent, root)}`;
}
function rootOfTrail(trail: readonly Pill[], root: "o" | "m"): "o" | "m" {
  return trail.length === 0 ? root : trail[0].dim === "m" ? "m" : "o";
}

// ── Figures ──
// One child's sums on one side, in hours and in $ of the priced hours.
export interface Figures {
  h: number;
  mainH: number;
  usd: number;
  mainUsd: number;
  unpricedH: number;
  unpricedMainH: number;
  approx: boolean;
}
const noFigures = (): Figures => ({
  h: 0,
  mainH: 0,
  usd: 0,
  mainUsd: 0,
  unpricedH: 0,
  unpricedMainH: 0,
  approx: false,
});
function addFigures(into: Figures, f: Figures): void {
  into.h += f.h;
  into.mainH += f.mainH;
  into.usd += f.usd;
  into.mainUsd += f.mainUsd;
  into.unpricedH += f.unpricedH;
  into.unpricedMainH += f.unpricedMainH;
  into.approx = into.approx || f.approx;
}

// What a side's figures divide by: its days with data, their bars of the
// rollup (rollupUnits) and their pushes to main; in $, only the priced days
// and their pushes, as pricedDays counts them.
export interface SideDivisors {
  asked: number; // calendar days asked for
  days: number;
  units: number; // rollupUnits of the days with data
  pushes: number;
  pricedDays: number;
  pricedUnits: number; // rollupUnits of the priced days
  pricedPushes: number;
  pricedNote: string | null; // "6 of 7 days priced" when some aren't
  pricingNotes: string[]; // how its days were priced: borrowed, provisional
  range: DayRange | null; // its first to last day with data
  filling: number;
}
export function sideDivisors(
  answer: CostScope,
  side: 0 | 1,
  pricer: Pricer | null,
  rollup: Rollup = "day"
): SideDivisors {
  const s = answer.sides[side];
  const range = side === 0 ? answer.a : answer.b;
  const priced = pricer === null ? null : pricedDays(pricer, s);
  const n = s.days.length;
  return {
    asked: daysIn(range),
    days: n,
    units: rollupUnits(rollup, s.days),
    pushes: s.pushes.reduce((t, p) => t + p, 0),
    pricedDays: priced?.days ?? 0,
    pricedUnits:
      pricer === null
        ? 0
        : rollupUnits(
            rollup,
            s.days.filter((d) => pricer.dayKind(d) !== "gap")
          ),
    pricedPushes: priced?.pushes ?? 0,
    pricedNote: priced?.note ?? null,
    pricingNotes: pricer === null ? [] : pricingNotes(pricer, s.days).lines,
    range: n === 0 ? null : { from: s.days[0], to: s.days[n - 1] },
    filling: s.filling.length,
  };
}

// Every child's figures on both sides, plus the total, each cell priced with
// its piece's rate: $ = h·priced·rate. In $ the drill asks for day pieces, so
// a rate is its day's, as the chart prices it; a week piece spanning two rate
// periods gets their mean, marked ≈.
export interface LevelFigures {
  children: [Figures, Figures][];
  total: [Figures, Figures];
  divisors: [SideDivisors, SideDivisors];
  tests: [number, number, number, number][]; // per child: executed A, B, skipped A, B (hours)
}
export function levelFigures(
  answer: CostScope,
  pricer: Pricer | null,
  rollup: Rollup = "day"
): LevelFigures {
  const children = answer.children.map(
    () => [noFigures(), noFigures()] as [Figures, Figures]
  );
  const rates = new Map<string, ReturnType<Pricer["piece"]>>();
  const pieceDays = answer.pieces.map((piece) =>
    answer.sides[piece.side].days.filter(
      (d) => d >= piece.from && d <= piece.to
    )
  );
  for (const [side, piece, child, label, h, mainH] of answer.cells) {
    const f = children[child]?.[side as 0 | 1];
    if (f === undefined) continue;
    f.h += h;
    f.mainH += mainH;
    if (pricer === null) continue;
    const key = `${piece}|${label}`;
    let rate = rates.get(key);
    if (rate === undefined) {
      rate = pricer.piece(answer.labels[label] ?? "", pieceDays[piece] ?? []);
      rates.set(key, rate);
    }
    if (rate.rate === null) {
      f.unpricedH += h;
      f.unpricedMainH += mainH;
    } else {
      f.usd += h * rate.priced * rate.rate;
      f.mainUsd += mainH * rate.priced * rate.rate;
      f.unpricedH += h * (1 - rate.priced);
      f.unpricedMainH += mainH * (1 - rate.priced);
      if (!rate.exact || rate.borrowed) f.approx = true;
    }
  }
  const total: [Figures, Figures] = [noFigures(), noFigures()];
  for (const [a, b] of children) {
    addFigures(total[0], a);
    addFigures(total[1], b);
  }
  const tests = answer.children.map(
    () => [0, 0, 0, 0] as [number, number, number, number]
  );
  for (const [side, child, executedH, skippedH] of answer.tests) {
    const t = tests[child];
    if (t === undefined) continue;
    t[side] += executedH;
    t[2 + side] += skippedH;
  }
  return {
    children,
    total,
    divisors: [
      sideDivisors(answer, 0, pricer, rollup),
      sideDivisors(answer, 1, pricer, rollup),
    ],
    tests,
  };
}

// What a figure is per: a bar of the rollup (Total; a day in Day view), a
// day with data, or a commit.
export type Basis = "unit" | "day" | "commit";
export const basisOf = (per: Per): Basis => (per === "day" ? "unit" : "commit");

// A side's figure in the unit and basis, null where it can't be said: no
// days (no data), no pushes, or in $ hours with no price.
export function shownValue(
  f: Figures,
  d: SideDivisors,
  unit: Unit,
  basis: Basis
): number | null {
  if (d.days === 0) return null;
  const unitBasis = basis === "unit";
  if (unit === "hours") {
    if (basis !== "commit") return f.h / (unitBasis ? d.units : d.days);
    return d.pushes > 0 ? f.mainH / d.pushes : null;
  }
  if (basis !== "commit") {
    if (f.h === 0) return 0;
    const by = unitBasis ? d.pricedUnits : d.pricedDays;
    return by > 0 && f.unpricedH < f.h ? f.usd / by : null;
  }
  if (f.mainH === 0) return d.pricedPushes > 0 ? 0 : null;
  return d.pricedPushes > 0 && f.unpricedMainH < f.mainH
    ? f.mainUsd / d.pricedPushes
    : null;
}

// A side's total over the days its per day divides by: every day with data
// in hours, the priced ones in $. Per day × those days, so the two never
// disagree, and blank where per day is. Whatever the per.
export interface SideTotal {
  value: number | null;
  blank: string; // what a null reads, as per day's
  approx: boolean; // ≈: a rate inexact or borrowed, or days left unpriced
  days: string; // what it covers: "7 days", "1 day", "6 of 7 days priced"
  range: DayRange | null; // first to last day with data
  notes: string[]; // $: how its days were priced
}
export function sideTotal(f: Figures, d: SideDivisors, unit: Unit): SideTotal {
  const usd = unit === "usd";
  const value =
    shownValue(f, d, unit, "day") === null ? null : usd ? f.usd : f.h;
  // A side with no hours is $0 however its days were priced.
  const partial = usd && f.h > 0 && d.pricedNote !== null;
  return {
    value,
    blank: blankText(f, d, unit, "day"),
    approx: value !== null && usd && (f.approx || partial),
    days: partial
      ? (d.pricedNote as string)
      : `${d.days} ${d.days === 1 ? "day" : "days"}`,
    range: d.range,
    notes: usd ? d.pricingNotes : [],
  };
}

// ── Rows ──
export interface DrillRow {
  key: string; // the API's child name
  by: ScopeBy;
  name: string;
  detail: string; // muted: a file's directory, a lane's workflow
  bucket: boolean;
  info: ScopeChildInfo;
  a: number | null; // A in the unit, per bar of the rollup or per commit; null = no data / unpriced
  b: number | null;
  // What a null side reads: "no data" (no days), "no rates" ($ and none of
  // its hours priced), "–" (nothing to divide by).
  blankA: string;
  blankB: string;
  delta: number | null; // b − a
  pct: number | null; // (b − a) / a; null when A is 0 or missing
  approx: boolean; // ≈ on either side
  approxA: boolean; // ≈: a rate on that side inexact or borrowed
  approxB: boolean;
  unpricedH: number; // A + B hours with no price ($ only)
  other: { a: number | null; b: number | null }; // the other per (per commit, or per day)
  daily: { a: number | null; b: number | null }; // per day, whatever the per
  totals: { a: SideTotal; b: SideTotal }; // over each side, whatever the per
  notOnMain: boolean; // no push:main hours on either side
  hidden: boolean;
  tests: { a: number; b: number; skippedA: number; skippedB: number } | null; // per day
  labels: { label: string; b: number }[]; // B per day by runner label (lanes, labels)
}

export interface LevelView {
  answer: CostScope;
  unit: Unit; // hours without a pricer
  per: Per;
  rollup: Rollup; // what Total is per
  figures: LevelFigures;
  rows: DrillRow[]; // every child, in answer order
  total: DrillRow;
  aHasDays: boolean;
  bHasDays: boolean;
}

// Why a side has no figure (shownValue is null).
export function blankText(
  f: Figures,
  d: SideDivisors,
  unit: Unit,
  basis: Basis
): string {
  if (d.days === 0) return "no data";
  if (unit === "usd") {
    const unpriced =
      basis !== "commit"
        ? d.pricedDays === 0 || (f.h > 0 && f.unpricedH >= f.h)
        : d.pricedPushes === 0 || (f.mainH > 0 && f.unpricedMainH >= f.mainH);
    if (unpriced) return "no rates";
  }
  return "–";
}

function rowOf(
  key: string,
  by: ScopeBy,
  info: ScopeChildInfo,
  [fa, fb]: [Figures, Figures],
  divisors: [SideDivisors, SideDivisors],
  unit: Unit,
  per: Per,
  extra: Pick<DrillRow, "tests" | "labels">
): DrillRow {
  const basis = basisOf(per);
  const a = shownValue(fa, divisors[0], unit, basis);
  const b = shownValue(fb, divisors[1], unit, basis);
  const otherPer: Per = per === "day" ? "commit" : "day";
  const hoursA = shownValue(fa, divisors[0], "hours", per) ?? 0;
  const hoursB = shownValue(fb, divisors[1], "hours", per) ?? 0;
  const floor = per === "day" ? HIDE_PER_DAY : HIDE_PER_COMMIT;
  const { name, detail } = childName(by, key, info);
  return {
    key,
    by,
    name,
    detail,
    bucket: isBucketChild(by, key),
    info,
    a,
    b,
    blankA: blankText(fa, divisors[0], unit, basis),
    blankB: blankText(fb, divisors[1], unit, basis),
    delta: a === null || b === null ? null : b - a,
    pct: a === null || b === null || a === 0 ? null : (b - a) / a,
    approx: unit === "usd" && (fa.approx || fb.approx),
    approxA: unit === "usd" && fa.approx,
    approxB: unit === "usd" && fb.approx,
    unpricedH: unit === "usd" ? fa.unpricedH + fb.unpricedH : 0,
    other: {
      a: shownValue(fa, divisors[0], unit, otherPer),
      b: shownValue(fb, divisors[1], unit, otherPer),
    },
    daily: {
      a: shownValue(fa, divisors[0], unit, "day"),
      b: shownValue(fb, divisors[1], unit, "day"),
    },
    totals: {
      a: sideTotal(fa, divisors[0], unit),
      b: sideTotal(fb, divisors[1], unit),
    },
    notOnMain: fa.mainH === 0 && fb.mainH === 0,
    hidden: hoursA < floor && hoursB < floor,
    ...extra,
  };
}

// An answer's rows in the unit and per: every child (hidden ones marked) and
// the total, Total per bar of the rollup (per day in Day view). by=f|lane
// rows carry test time a day from test_cost.
export function levelView(
  answer: CostScope,
  opts: { unit: Unit; per: Per; pricer: Pricer | null; rollup?: Rollup }
): LevelView {
  const unit = opts.pricer === null ? "hours" : opts.unit;
  const rollup = opts.rollup ?? "day";
  const figures = levelFigures(answer, opts.pricer, rollup);
  const [da, db] = figures.divisors;
  const labelsB = answer.children.map(() => new Map<number, number>());
  if (answer.by === "lane" || answer.by === "label") {
    for (const [side, , child, label, h] of answer.cells) {
      if (side !== 1) continue;
      const m = labelsB[child];
      m.set(label, (m.get(label) ?? 0) + h);
    }
  }
  const withTests = answer.by === "f" || answer.by === "lane";
  const rows = answer.children.map((key, c) => {
    const t = figures.tests[c];
    return rowOf(
      key,
      answer.by,
      answer.info[c] ?? {},
      figures.children[c],
      figures.divisors,
      unit,
      opts.per,
      {
        tests: withTests
          ? {
              a: da.days > 0 ? t[0] / da.days : 0,
              b: db.days > 0 ? t[1] / db.days : 0,
              skippedA: da.days > 0 ? t[2] / da.days : 0,
              skippedB: db.days > 0 ? t[3] / db.days : 0,
            }
          : null,
        labels: Array.from(labelsB[c].entries())
          .map(([l, h]) => ({
            label: answer.labels[l] ?? "",
            b: db.days > 0 ? h / db.days : 0,
          }))
          .sort((x, y) => y.b - x.b),
      }
    );
  });
  const testsTotal = figures.tests.reduce(
    (t, x) => [t[0] + x[0], t[1] + x[1], t[2] + x[2], t[3] + x[3]],
    [0, 0, 0, 0]
  );
  const total = rowOf(
    "",
    answer.by,
    {},
    figures.total,
    figures.divisors,
    unit,
    opts.per,
    {
      tests: withTests
        ? {
            a: da.days > 0 ? testsTotal[0] / da.days : 0,
            b: db.days > 0 ? testsTotal[1] / db.days : 0,
            skippedA: da.days > 0 ? testsTotal[2] / da.days : 0,
            skippedB: db.days > 0 ? testsTotal[3] / db.days : 0,
          }
        : null,
      labels: [],
    }
  );
  return {
    answer,
    unit,
    per: opts.per,
    rollup,
    figures,
    rows,
    total,
    aHasDays: da.days > 0,
    bHasDays: db.days > 0,
  };
}

export function rowByKey(view: LevelView | null, key: string): DrillRow | null {
  return view?.rows.find((r) => r.key === key) ?? null;
}

// The change in the chosen metric, for the bar and for ranking: hours (or $)
// or %, % capped at +200% (new counts as the cap).
export function changeMetric(row: DrillRow, chg: "h" | "pct"): number {
  if (row.delta === null) return 0;
  if (chg === "h") return row.delta;
  if (row.pct === null) return row.delta > 0 ? PCT_CAP : 0;
  return Math.min(row.pct, PCT_CAP);
}

// By the column header clicked: change = |change| desc, grew = change
// desc, shrank = change asc, a and b = that side desc, and the pct ones the
// same by percent; buckets last, then name. Without A's days, B desc. The
// order alone sets which change it reads (_chg is kept for callers).
export function sortRows(
  rows: readonly DrillRow[],
  sort: DrillQuery["sort"],
  _chg: "h" | "pct",
  aHasDays: boolean
): DrillRow[] {
  const by = aHasDays ? sort : "b";
  const metric = by.startsWith("pct") ? "pct" : "h";
  const key = (r: DrillRow) =>
    by === "b"
      ? r.b ?? 0
      : by === "a"
      ? r.a ?? 0
      : by === "grew" || by === "pctgrew"
      ? changeMetric(r, metric)
      : by === "shrank" || by === "pctshrank"
      ? -changeMetric(r, metric)
      : Math.abs(changeMetric(r, metric));
  return [...rows].sort(
    (x, y) =>
      Number(x.bucket) - Number(y.bucket) ||
      key(y) - key(x) ||
      (y.b ?? 0) - (x.b ?? 0) ||
      // B with no value (in $, a week without rates): A's order
      (y.a ?? 0) - (x.a ?? 0) ||
      x.name.localeCompare(y.name)
  );
}

// The top-N cut by the same key, the kept row always shown, buckets after
// it: what a level lists, and how many rows "N more" holds.
export function cutRows(
  sorted: readonly DrillRow[],
  opts: { top: number; expanded: boolean; keep?: string | null }
): { shown: DrillRow[]; more: DrillRow[]; buckets: DrillRow[] } {
  const visible = sorted.filter((r) => !r.hidden || r.key === opts.keep);
  if (opts.expanded) {
    return {
      shown: visible,
      more: [],
      buckets: visible.filter((r) => r.bucket),
    };
  }
  const plain = visible.filter((r) => !r.bucket);
  const buckets = visible.filter((r) => r.bucket);
  const head = plain.slice(0, opts.top);
  const rest = plain.slice(opts.top);
  const kept = rest.find((r) => r.key === opts.keep);
  return {
    shown: [...head, ...(kept ? [kept] : []), ...buckets],
    more: rest.filter((r) => r !== kept),
    buckets,
  };
}

// Several rows summed, in the unit and per: a fold line or "N more".
export function sumRows(view: LevelView, keys: readonly string[]): DrillRow {
  const want = new Set(keys);
  const sum: [Figures, Figures] = [noFigures(), noFigures()];
  view.answer.children.forEach((child, c) => {
    if (!want.has(child)) return;
    addFigures(sum[0], view.figures.children[c][0]);
    addFigures(sum[1], view.figures.children[c][1]);
  });
  return rowOf(
    "",
    view.answer.by,
    {},
    sum,
    view.figures.divisors,
    view.unit,
    view.per,
    { tests: null, labels: [] }
  );
}

// ── Expand in place ──
// A row opens under itself onto its own children, one /scope each, without
// moving the trail: an owner onto its machines, a machine onto its owners
// (or, at the machine root, its runner labels when asked), a row whose
// scope pins both an owner and a machine onto its runner labels, and a row
// whose scope pins a file and a machine (a pair's file, a file's machine)
// onto the file's lanes there (/scope by=lane, never /cases). Lanes and
// labels don't open. scope is the trail of the level listing the row;
// opens is what a machine row at the machine root lists.
export type MachineOpens = "o" | "label";
export interface Expansion {
  trail: Pill[]; // the row's own scope: what Drill in would pin
  by: ScopeBy;
}
export function expansionOf(
  scope: readonly Pill[],
  by: ScopeBy,
  key: string,
  opens: MachineOpens = "o"
): Expansion | null {
  if (by !== "o" && by !== "m" && by !== "f") return null;
  const trail = appendPill(scope, { dim: by, value: key });
  const pinned = (dim: Dim) => trail.some((p) => p.dim === dim);
  if (pinned("f")) return pinned("m") ? { trail, by: "lane" } : null;
  if (by === "f") return null; // a file pill needs an owner or a machine
  if (pinned("o") && pinned("m")) return { trail, by: "label" };
  if (by === "o") return { trail, by: "m" };
  return { trail, by: opens };
}

// Whether a machine row offers Owners | Runners: only where its owners are
// a real split, with no owner (or file) pinned above it.
export function machineSwitches(scope: readonly Pill[], by: ScopeBy): boolean {
  return by === "m" && !scope.some((p) => p.dim === "o" || p.dim === "f");
}

// A by=label answer's children are "label|workflow": one row per runner
// label with its workflows summed (named in detail, largest first), so the
// labels sum to the scope. keys maps each row to the children it sums.
export function labelRows(view: LevelView): {
  rows: DrillRow[];
  keys: Map<string, string[]>;
} {
  const groups = new Map<string, { keys: string[]; workflows: string[] }>();
  view.answer.children.forEach((child, c) => {
    const info = view.answer.info[c] ?? {};
    const at = child.lastIndexOf("|");
    const label = info.label ?? (at < 0 ? child : child.slice(0, at));
    const workflow = info.workflow ?? (at < 0 ? "" : child.slice(at + 1));
    const g = groups.get(label) ?? { keys: [], workflows: [] };
    g.keys.push(child);
    if (workflow !== "") g.workflows.push(workflowShort(workflow));
    groups.set(label, g);
  });
  const keys = new Map<string, string[]>();
  const rows = Array.from(groups.entries()).map(([label, g]) => {
    keys.set(label, g.keys);
    return {
      ...sumRows(view, g.keys),
      key: label,
      by: "label" as const,
      name: label,
      detail: g.workflows.join(", "),
      info: { label },
    };
  });
  return { rows, keys };
}

// A by=lane answer's rows ("env_id|workflow", the workflow in detail) as an
// open file lists them: each named by its environment's tokens that not
// every listed lane shares (the shared ones are the open row's machine).
export function laneRows(view: LevelView): DrillRow[] {
  const environments = new Map<string, EnvironmentRecord>();
  for (const r of view.rows) {
    const e = r.info.environment;
    if (e && !r.hidden) environments.set(e.id, e);
  }
  const common = commonTokens(Array.from(environments.values()));
  return view.rows.map((r) => {
    const e = r.info.environment;
    const own = e
      ? environmentTokenTexts(e).filter((t) => !common.includes(t))
      : [];
    return own.length > 0 ? { ...r, name: own.join(" · ") } : r;
  });
}

// Rows an open row lists before "N more" (the rest open in place).
export const NESTED_TOP = 8;

// An open row's children as the table lists them (DrillQuery.sort within
// the level, hidden rows left out): the first NESTED_TOP (all of them when
// only one more would be folded), the rest summed in one "N more" row, then
// the buckets. total is the open row's scope as this answer sums it: the
// base of each child's share.
export function expansionRows(
  view: LevelView,
  sort: DrillQuery["sort"]
): {
  shown: DrillRow[];
  rest: DrillRow[]; // folded into more, listed under it once it opens
  more: DrillRow | null; // the rest summed; null when nothing is folded
  buckets: DrillRow[];
  total: DrillRow;
} {
  const labels = view.answer.by === "label" ? labelRows(view) : null;
  const rows = labels
    ? labels.rows
    : view.answer.by === "lane"
    ? laneRows(view)
    : view.rows;
  const visible = sortRows(rows, sort, "h", view.aHasDays).filter(
    (r) => !r.hidden
  );
  const plain = visible.filter((r) => !r.bucket);
  const buckets = visible.filter((r) => r.bucket);
  const cut = plain.length > NESTED_TOP + 1 ? NESTED_TOP : plain.length;
  const rest = plain.slice(cut);
  const childKeys = (r: DrillRow) => labels?.keys.get(r.key) ?? [r.key];
  return {
    shown: plain.slice(0, cut),
    rest,
    more: rest.length > 0 ? sumRows(view, rest.flatMap(childKeys)) : null,
    buckets,
    total: view.total,
  };
}

// ── Text ──
// The change in % as the table writes it: ▲ 12× from 9.5×, "new" when
// A is 0 with A's days present, "gone" when B is 0, ±0% under 0.5%; blank
// without A's days.
export function changeText(row: Pick<DrillRow, "a" | "b">): string {
  const { a, b } = row;
  if (a === null || b === null) return "";
  if (a === 0) return b === 0 ? "±0%" : "new";
  if (b === 0) return "gone";
  const p = (b - a) / a;
  if (Math.abs(p) < 0.005) return "±0%";
  if (b / a >= 9.5) return `▲ ${Math.round(b / a)}×`;
  const pct = Math.max(1, Math.round(Math.abs(p * 100)));
  return p > 0 ? `▲ +${pct}%` : `▼ −${pct}%`;
}

export function amount(unit: Unit, v: number): string {
  return fineAmountLabel(costUnit(unit), v);
}
// "▲ +2 h", "▼ −$0.25", and "▼ <0.1 h" for a sliver.
export function deltaText(unit: Unit, v: number | null): string {
  if (v === null) return "";
  if (Math.abs(v) < 1e-9) return "±0";
  const size = amount(unit, Math.abs(v));
  const sign = size.startsWith("<") ? "" : v > 0 ? "+" : "−";
  return `${v > 0 ? "▲" : "▼"} ${sign}${size}`;
}
// A side's figure, "≈" first when its rates are inexact or borrowed.
export function valueText(
  unit: Unit,
  v: number | null,
  approx = false
): string {
  return v === null ? "–" : `${approx ? "≈" : ""}${amount(unit, v)}`;
}
export function arrowText(
  unit: Unit,
  a: number | null,
  b: number | null,
  approxA = false,
  approxB = false
): string {
  return `${valueText(unit, a, approxA)} → ${valueText(unit, b, approxB)}`;
}
export function perWord(per: Per, rollup: Rollup = "day"): string {
  return per === "day" ? rollupWord(rollup) : "per commit";
}
export function unitWords(
  unit: Unit,
  per: Per,
  rollup: Rollup = "day"
): string {
  return `${unit === "usd" ? "$" : "runner-hours"} ${perWord(per, rollup)}`;
}

// ── Scales ──
// One linear scale per table (and one per canvas) for the butterfly halves:
// nice(max over shown rows of max(A, B), 4 ticks).
export interface HalfScale {
  ticks: number[];
  top: number;
}
export function halfScale(rows: readonly DrillRow[]): HalfScale {
  const max = Math.max(0, ...rows.flatMap((r) => [r.a ?? 0, r.b ?? 0]));
  const ticks = niceTicks(max, 4);
  return { ticks, top: ticks[ticks.length - 1] };
}

// B's side: kept = min(A, B) solid from 0; lost (A > B) hatched from B
// to A; gained (B > A) solid from A to B; within 0.2% of the track, B only.
// Fractions of the half's track.
export interface Segments {
  a: number;
  kept: number;
  lost: number;
  gained: number;
  end: number; // the furthest B-side extent
}
export function segments(
  a: number | null,
  b: number | null,
  top: number
): Segments {
  const f = (v: number) => (top > 0 ? Math.max(0, Math.min(1, v / top)) : 0);
  const fa = a === null ? 0 : f(a);
  if (b === null) return { a: fa, kept: 0, lost: 0, gained: 0, end: 0 };
  const fb = f(b);
  if (a === null || Math.abs(fa - fb) < SAME_TRACK) {
    return { a: fa, kept: fb, lost: 0, gained: 0, end: fb };
  }
  return {
    a: fa,
    kept: Math.min(fa, fb),
    lost: Math.max(0, fa - fb),
    gained: Math.max(0, fb - fa),
    end: Math.max(fa, fb),
  };
}

// The change column: one diverging scale with a shared zero; the smaller
// side keeps at least 16% of the width, so growth stays visible. Still one
// linear scale: the smaller side's extent is widened, never stretched.
export interface ChangeScale {
  lo: number;
  hi: number;
  zero: number; // fraction of the width
  ticks: number[];
}
export function changeScale(values: readonly number[]): ChangeScale {
  const neg = Math.max(0, ...values.map((v) => -v));
  const pos = Math.max(0, ...values);
  const big = Math.max(neg, pos);
  if (!(big > 0)) return { lo: -1, hi: 1, zero: 0.5, ticks: [0] };
  const bigTicks = niceTicks(big, 2);
  const extent = bigTicks[bigTicks.length - 1];
  const minSmall = (extent * CHANGE_MIN_SIDE) / (1 - CHANGE_MIN_SIDE);
  const small = Math.max(Math.min(neg, pos), minSmall);
  const lo = neg >= pos ? -extent : -small;
  const hi = neg >= pos ? small : extent;
  const ticks = [
    ...bigTicks
      .filter((t) => t > 0 && t <= -lo + 1e-9)
      .map((t) => -t)
      .reverse(),
    0,
    ...bigTicks.filter((t) => t > 0 && t <= hi + 1e-9),
  ];
  return { lo, hi, zero: -lo / (hi - lo), ticks };
}
export function changeX(scale: ChangeScale, v: number): number {
  const c = Math.max(scale.lo, Math.min(scale.hi, v));
  return (c - scale.lo) / (scale.hi - scale.lo);
}

// Compact axis labels: "5K", "−2K", "50%".
export function tickText(
  v: number,
  chg: "h" | "pct" = "h",
  unit: Unit = "hours"
): string {
  if (chg === "pct") return `${Math.round(v * 100)}%`;
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  const text =
    abs >= 1000
      ? `${Number((abs / 1000).toPrecision(3))}K`
      : `${Number(abs.toPrecision(3))}`;
  return unit === "usd" ? `${sign}$${text}` : `${sign}${text}`;
}

// ── Sentence ──
export interface Phrase {
  text: string;
  strong?: boolean;
  tone?: "up" | "down";
}
export function changeSentence(opts: {
  name: string;
  scope: DrillRow;
  children: readonly DrillRow[];
  unit: Unit;
  per: Per;
  rollup?: Rollup;
  aHasDays: boolean;
}): Phrase[] | null {
  const { scope, unit, per } = opts;
  if (!opts.aHasDays || scope.a === null || scope.b === null) return null;
  const d = scope.b - scope.a;
  const words = perWord(per, opts.rollup);
  const out: Phrase[] = [{ text: opts.name, strong: true }];
  if (scope.a === 0 && scope.b === 0) return null;
  if (scope.a > 0 && Math.abs(d / scope.a) < 0.005) {
    out.push({
      text: ` held steady at ${amount(unit, scope.b)} ${words} from A to B.`,
    });
    return out;
  }
  const fell = d < 0;
  out.push({ text: ` ${fell ? "fell" : "rose"} ` });
  out.push({ text: amount(unit, Math.abs(d)), strong: true });
  out.push({
    text: ` ${words}${
      scope.a > 0 ? ` (${changeText(scope).replace(/^[▲▼] /, "")})` : ""
    } from A to B.`,
  });
  const floor = per === "day" ? HIDE_PER_DAY : HIDE_PER_COMMIT;
  const moves = opts.children
    .filter((c) => c.delta !== null && Math.abs(c.delta) > floor)
    .map((c) => ({ row: c, d: c.delta as number }));
  const same = moves
    .filter((m) => (fell ? m.d < 0 : m.d > 0))
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
  const counter = moves
    .filter((m) => (fell ? m.d > 0 : m.d < 0))
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
  if (same.length > 0) {
    const lead = same[0];
    const share = Math.abs(lead.d / d);
    out.push({ text: " " });
    out.push({ text: lead.row.name, strong: true });
    // Past 100% the lead moved more than the scope did (others moved back):
    // "explains 127% of it" reads wrong, so the share is left out.
    out.push({
      text: ` explains ${amount(unit, Math.abs(lead.d))} of it${
        share <= 1 ? ` (${Math.round(share * 100)}%)` : ""
      }.`,
    });
  }
  if (opts.children.length > 0) {
    const verb = fell ? "grew" : "shrank";
    if (counter.length === 0) {
      out.push({ text: ` Nothing here ${verb}.` });
    } else {
      const lead = counter[0];
      out.push({
        text:
          counter.length === 1
            ? " Only "
            : ` ${counter.length} ${verb}, led by `,
      });
      out.push({ text: lead.row.name, strong: true });
      out.push({ text: counter.length === 1 ? ` ${verb} (` : " (" });
      out.push({
        text: deltaText(unit, lead.d),
        tone: lead.d > 0 ? "up" : "down",
      });
      out.push({ text: ")." });
    }
  }
  return out;
}

// ── Page facts: the headline numbers ──
// The facts row under the page's title, for the repository and workflow
// scope, whatever the trail, A/B and per are: the last FACTS_DAYS whole days
// with data of the root trend's daily cells (from January 1), fewer while
// the data holds fewer. Per day is their mean, a year per day × 365 (a
// month: a twelfth), per commit their push:main hours ÷ pushes to main, and
// attributed to owners the share of their hours with a named owner. In $
// each day is priced at its own rate period and divides by the priced days:
// ≈ when a day borrows rates or not every day is priced, "no
// rates" when none is; hours on labels without a rate count $0, and each
// figure keeps their share.
export const FACTS_DAYS = 28;

// The root trend's daily series. days: days with data, ascending (the
// per-day divisor); pushes: each day's pushes to main; cells: [day, label,
// h, mainH].
export interface DailySeries {
  days: readonly Day[];
  filling: readonly Day[];
  pushes: readonly number[];
  labels: readonly string[];
  cells: readonly (readonly number[])[];
}
export function trendDaily(t: CostTrend): DailySeries {
  return {
    days: t.daily.days,
    filling: t.daily.filling ?? [],
    pushes: t.daily.pushes ?? [],
    labels: t.labels,
    cells: t.daily.cells,
  };
}

// The last FACTS_DAYS whole days of a series (fewer when the data has
// fewer): a day still filling is left out.
export function recentDays(daily: DailySeries): Day[] {
  const filling = new Set(daily.filling);
  return daily.days.filter((d) => !filling.has(d)).slice(-FACTS_DAYS);
}

// "Last 28 days", "Last day"; null without days. The dates are left to
// Per day's title.
export function windowText(days: readonly Day[]): string | null {
  const n = days.length;
  if (n === 0) return null;
  return `Last ${n === 1 ? "day" : `${n} days`}`;
}

// A figure over the window: null reads as blank ("no data", "no rates",
// "–"); priced: $ from fewer priced days than days; unpriced: in $, the
// share of its hours on labels without a rate ($0), null in hours.
export interface WindowFigure {
  value: number | null;
  approx: boolean;
  priced: { days: number; of: number } | null;
  unpriced: number | null;
  blank: string;
}
export interface PageFacts {
  days: Day[];
  window: string | null;
  perDay: WindowFigure;
  perCommit: WindowFigure & { pushes: number };
  owned: number | null;
}

export function pageFacts(
  trend: CostTrend,
  unit: Unit,
  pricer: Pricer | null
): PageFacts {
  const daily = trendDaily(trend);
  const days = recentDays(daily);
  const rates = unit === "usd" ? pricer : null;
  const wanted = new Set(days);
  // The window's days that count: every one in hours, the priced ones in $.
  const counted = daily.days.map(
    (d) => wanted.has(d) && (rates === null || rates.dayKind(d) !== "gap")
  );
  let countedDays = 0;
  let pushes = 0;
  counted.forEach((c, i) => {
    if (!c) return;
    countedDays += 1;
    pushes += daily.pushes[i] ?? 0;
  });
  let sum = 0;
  let mainSum = 0;
  // The counted days' hours, all and on pushes to main, and those of them
  // on labels without a rate.
  const hours = { all: 0, main: 0, allUnpriced: 0, mainUnpriced: 0 };
  for (const [d, label, h, mainH] of daily.cells) {
    if (!counted[d]) continue;
    hours.all += h;
    hours.main += mainH ?? 0;
    const rate =
      rates === null ? 1 : rates.rate(daily.labels[label] ?? "", daily.days[d]);
    if (rate === null) {
      hours.allUnpriced += h;
      hours.mainUnpriced += mainH ?? 0;
      continue;
    }
    sum += h * rate;
    mainSum += (mainH ?? 0) * rate;
  }
  const unpriced = (part: number, of: number) =>
    rates === null || of <= 0 ? null : part / of;
  const partial = rates !== null && countedDays < days.length;
  const approx =
    rates !== null &&
    (partial || days.some((d) => rates.dayKind(d) === "borrowed"));
  const blank =
    days.length === 0 ? "no data" : countedDays === 0 ? "no rates" : "–";
  const figure = (
    value: number | null,
    unpricedShare: number | null
  ): WindowFigure => ({
    value,
    approx: value !== null && approx,
    priced:
      value !== null && partial ? { days: countedDays, of: days.length } : null,
    unpriced: value === null ? null : unpricedShare,
    blank,
  });
  return {
    days,
    window: windowText(days),
    perDay: figure(
      countedDays > 0 ? sum / countedDays : null,
      unpriced(hours.allUnpriced, hours.all)
    ),
    perCommit: {
      ...figure(
        pushes > 0 ? mainSum / pushes : null,
        unpriced(hours.mainUnpriced, hours.main)
      ),
      pushes,
    },
    owned:
      days.length === 0
        ? null
        : ownedShareOfTrend(trend, {
            from: days[0],
            to: days[days.length - 1],
          }),
  };
}

// The share of a range's runner-hours in test files with a named owner
// (unattributed:* has none), from the day trend's cells; null unless the
// trend holds every day of the range.
export function ownedShareOfTrend(
  trend: CostTrend,
  range: DayRange
): number | null {
  if (
    trend.rollup !== "day" ||
    range.from < trend.start ||
    range.to >= trend.end
  ) {
    return null;
  }
  let owned = 0;
  let total = 0;
  for (const [period, owner, , h] of trend.cells) {
    const day = trend.periods[period];
    if (day === undefined || day < range.from || day > range.to) continue;
    total += h;
    if (!isBucket(trend.owners[owner] ?? "")) owned += h;
  }
  return total > 0 ? owned / total : null;
}

// ── Chips ──
export function sideChips(view: LevelView): string[] {
  const [da, db] = view.figures.divisors;
  const chips: string[] = [];
  if (da.days === 0) chips.push("A has no data");
  else if (da.days < da.asked)
    chips.push(`A has ${da.days} of ${da.asked} days`);
  if (db.days === 0) chips.push("B has no data");
  else if (db.days < db.asked)
    chips.push(`B has ${db.days} of ${db.asked} days`);
  // $ divides by the priced days only.
  if (view.unit === "usd") {
    for (const [name, d] of [
      ["A", da],
      ["B", db],
    ] as const) {
      if (d.pricedDays > 0 && d.pricedDays < d.days)
        chips.push(`${name}: ${d.pricedDays} of ${d.days} days priced`);
    }
  }
  if (db.filling > 0)
    chips.push("B includes a day still filling (reads low a few %)");
  else if (da.filling > 0)
    chips.push("A includes a day still filling (reads low a few %)");
  return chips;
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
export function monthDay(day: Day): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
}
export function rangeText(r: DayRange): string {
  if (r.from === r.to) return monthDay(r.from);
  return r.from.slice(0, 7) === r.to.slice(0, 7)
    ? `${monthDay(r.from)}–${Number(r.to.slice(8, 10))}`
    : `${monthDay(r.from)} – ${monthDay(r.to)}`;
}

// ── Tests list link ──
// The tests list narrowed to the trail: owner, file, a CPU machine's OS,
// architecture and capability, a device machine's name; rolling 14 days over
// main and pull requests, since the drill counts every trigger.
export function testsListHref(
  repo: string,
  trail: readonly Pill[],
  machineInfo: ScopeChildInfo | undefined
): string {
  const search = new URLSearchParams();
  const o = trail.find((p) => p.dim === "o");
  const m = trail.find((p) => p.dim === "m");
  const f = trail.find((p) => p.dim === "f");
  const facet: TestsFacet = "owner";
  const name: NameFilter = "file";
  if (o && !isBucket(o.value)) search.set(facet, o.value);
  if (f) search.set(name, f.value);
  if (m && m.value !== UNKNOWN_MACHINE) {
    Object.entries(machineFacets(m.value, machineInfo)).forEach(([k, v]) =>
      search.set(k, v ?? "")
    );
  }
  search.set("window", "14d");
  search.set("ran_on", "main,pull_request");
  return `${testsPagePath(repo)}?${search}`;
}
export function machineFacets(
  machine: string,
  info: ScopeChildInfo | undefined
): Partial<Record<TestsFacet, string>> {
  if (info?.device) return { device_name: info.device };
  if (info?.cpu) {
    const [arch, cap] = info.cpu.split(" ");
    const os = (info.family ?? machine).replace(/ CPU$/, "").split(" ")[0];
    return {
      os: os.toLowerCase(),
      cpu_architecture: arch ?? "",
      cpu_capability: cap ?? "",
    };
  }
  const parts = machine.split(" ");
  if (parts.length === 3 && /^(Linux|Windows|macOS)$/.test(parts[0])) {
    return {
      os: parts[0].toLowerCase(),
      cpu_architecture: parts[1],
      cpu_capability: parts[2],
    };
  }
  return { device_name: machine };
}

// ── Test level: configurations and cases (/cases, ci.runs) ──
export interface CaseNums {
  runs: number;
  skipped: number;
  failed: number;
  reruns: number;
  ms: number;
}
const noNums = (): CaseNums => ({
  runs: 0,
  skipped: 0,
  failed: 0,
  reruns: 0,
  ms: 0,
});
export interface CaseRow {
  key: string; // "<test>|<env>|<envVars>" or "<env>:<envVars>" for a configuration
  test: { id: string; suite: string; name: string } | null;
  envId: string;
  envVarsId: string;
  environment: EnvironmentRecord | null;
  envVars: EnvVarsRecord | null;
  A: CaseNums;
  B: CaseNums;
  testsA: number;
  testsB: number;
  // Derived per day: test hours, skipped share, runs a day,
  // seconds per run (per file run for configurations), and the change split
  // into runs (at A's time per run) and time per run (at B's runs).
  tA: number | null;
  tB: number;
  d: number | null;
  p: number | null;
  skA: number | null;
  skB: number | null;
  runsA: number | null;
  runsB: number;
  prA: number | null;
  prB: number | null;
  effRun: number | null;
  effVol: number | null;
}

function derive(
  row: Omit<
    CaseRow,
    | "tA"
    | "tB"
    | "d"
    | "p"
    | "skA"
    | "skB"
    | "runsA"
    | "runsB"
    | "prA"
    | "prB"
    | "effRun"
    | "effVol"
  >,
  daysA: number,
  daysB: number,
  perFileRun: boolean
): CaseRow {
  const tB = daysB > 0 ? row.B.ms / 3.6e6 / daysB : 0;
  const tA = daysA > 0 ? row.A.ms / 3.6e6 / daysA : null;
  const runsB = daysB > 0 ? row.B.runs / daysB : 0;
  const runsA = daysA > 0 ? row.A.runs / daysA : null;
  const per = (n: CaseNums, tests: number) =>
    n.runs > 0
      ? perFileRun
        ? n.ms / 1000 / (n.runs / Math.max(1, tests))
        : n.ms / 1000 / n.runs
      : null;
  const prA = tA === null ? null : per(row.A, row.testsA);
  const prB = per(row.B, row.testsB);
  const d = tA === null ? null : tB - tA;
  let effRun: number | null = null;
  let effVol: number | null = null;
  if (tA !== null && d !== null) {
    if (row.A.runs === 0) {
      effRun = tB;
      effVol = 0;
    } else if (row.B.runs === 0) {
      effRun = 0;
      effVol = -tA;
    } else {
      const pa = row.A.ms / 1000 / row.A.runs;
      const pb = row.B.ms / 1000 / row.B.runs;
      effRun = ((pb - pa) * runsB) / 3600;
      effVol = d - effRun;
    }
  }
  return {
    ...row,
    tA,
    tB,
    d,
    p: tA === null || tA === 0 || d === null ? null : d / tA,
    skA: tA !== null && row.A.runs > 0 ? row.A.skipped / row.A.runs : null,
    skB: row.B.runs > 0 ? row.B.skipped / row.B.runs : null,
    runsA,
    runsB,
    prA,
    prB,
    effRun,
    effVol,
  };
}

export interface CasesView {
  aDays: number;
  bDays: number;
  configs: CaseRow[]; // every configuration, exact
  cells: CaseRow[]; // the ranked cells, paired across sides
  rankedOf: number;
  // The rest of each side beyond the ranked cells = Σ configs − Σ cells.
  restMs: [number, number];
}
export function casesView(cases: CostCases): CasesView {
  const aDays = cases.a.covered_days;
  const bDays = cases.b.covered_days;
  const envOf = (i: number) => cases.environments[i] ?? null;
  const evOf = (i: number) => cases.env_vars[i] ?? null;
  const configs = new Map<string, Parameters<typeof derive>[0]>();
  for (const [
    side,
    env,
    ev,
    tests,
    runs,
    skipped,
    failed,
    reruns,
    ms,
  ] of cases.configs) {
    const environment = envOf(env);
    const envVars = evOf(ev);
    const envId = environment?.id ?? String(env);
    const envVarsId = envVars?.id ?? String(ev);
    const key = `${envId}:${envVarsId}`;
    let row = configs.get(key);
    if (row === undefined) {
      row = {
        key,
        test: null,
        envId,
        envVarsId,
        environment,
        envVars,
        A: noNums(),
        B: noNums(),
        testsA: 0,
        testsB: 0,
      };
      configs.set(key, row);
    }
    const n = side === 0 ? row.A : row.B;
    n.runs += runs;
    n.skipped += skipped;
    n.failed += failed;
    n.reruns += reruns;
    n.ms += ms;
    if (side === 0) row.testsA += tests;
    else row.testsB += tests;
  }
  const cells = new Map<string, Parameters<typeof derive>[0]>();
  const cellMs: [number, number] = [0, 0];
  for (const [
    side,
    test,
    env,
    ev,
    runs,
    skipped,
    failed,
    reruns,
    ms,
  ] of cases.cells) {
    const environment = envOf(env);
    const envVars = evOf(ev);
    const t = cases.tests[test] ?? null;
    const envId = environment?.id ?? String(env);
    const envVarsId = envVars?.id ?? String(ev);
    const key = `${t?.id ?? test}|${envId}|${envVarsId}`;
    let row = cells.get(key);
    if (row === undefined) {
      row = {
        key,
        test: t,
        envId,
        envVarsId,
        environment,
        envVars,
        A: noNums(),
        B: noNums(),
        testsA: 1,
        testsB: 1,
      };
      cells.set(key, row);
    }
    const n = side === 0 ? row.A : row.B;
    n.runs += runs;
    n.skipped += skipped;
    n.failed += failed;
    n.reruns += reruns;
    n.ms += ms;
    cellMs[side === 0 ? 0 : 1] += ms;
  }
  const configRows = Array.from(configs.values()).map((r) =>
    derive(r, aDays, bDays, true)
  );
  const totalMs: [number, number] = [0, 0];
  for (const r of configRows) {
    totalMs[0] += r.A.ms;
    totalMs[1] += r.B.ms;
  }
  return {
    aDays,
    bDays,
    configs: configRows,
    cells: Array.from(cells.values()).map((r) =>
      derive(r, aDays, bDays, false)
    ),
    rankedOf: cases.ranked_of,
    restMs: [
      Math.max(0, totalMs[0] - cellMs[0]),
      Math.max(0, totalMs[1] - cellMs[1]),
    ],
  };
}

// The cases' view chips: what each keeps and how it ranks.
// rank = "day" ranks by all change a day; else by the change from time per
// run. Without A's coverage every view ranks by B's test time.
type CaseView = DrillQuery["cases"];
export const CASE_VIEW_LABELS: Record<NonNullable<CaseView> | "moves", string> =
  {
    moves: "Biggest moves",
    shrank: "Shrank",
    grew: "Grew",
    skipped: "Newly skipped",
    slower: "Slower per run",
    newb: "New in B",
    failing: "Failures",
  };
export const CASE_VIEW_ORDER = [
  "moves",
  "shrank",
  "grew",
  "skipped",
  "slower",
  "newb",
  "failing",
] as const;
export type CaseViewKey = (typeof CASE_VIEW_ORDER)[number];

export function caseMove(r: CaseRow, rank: DrillQuery["rank"]): number {
  return (rank === "day" ? r.d : r.effRun) ?? 0;
}
function viewTest(
  view: CaseViewKey,
  r: CaseRow,
  rank: DrillQuery["rank"]
): boolean {
  const m = caseMove(r, rank);
  switch (view) {
    case "moves":
      return true;
    case "shrank":
      return r.tA !== null && m < -0.005;
    case "grew":
      return r.tA !== null && m > 0.005;
    case "skipped":
      return r.skA !== null && r.skB !== null && r.skB - r.skA >= 0.2;
    case "slower":
      return (
        r.prA !== null &&
        r.prA > 0 &&
        r.prB !== null &&
        r.prB / r.prA >= 1.05 &&
        r.B.runs > 0
      );
    case "newb":
      return r.tA !== null && r.A.runs === 0 && r.B.runs > 0;
    case "failing":
      return r.A.failed + r.B.failed > 0;
  }
}
function viewKey(
  view: CaseViewKey,
  r: CaseRow,
  rank: DrillQuery["rank"],
  aCovered: boolean
): number {
  if (!aCovered) return view === "failing" ? -(r.B.failed * 10) : -r.tB;
  const m = caseMove(r, rank);
  switch (view) {
    case "moves":
      return -Math.abs(m);
    case "shrank":
      return m;
    case "grew":
      return -m;
    case "skipped":
      return -((r.skB ?? 0) - (r.skA ?? 0)) * 1000 - ((r.tA ?? 0) - r.tB);
    case "slower":
      return -((r.prB ?? 0) - (r.prA ?? 0)) * (r.runsB || 1);
    case "newb":
      return -r.tB;
    case "failing":
      return -(r.B.failed * 10 + r.A.failed);
  }
}
export function caseViewKey(cases: DrillQuery["cases"]): CaseViewKey {
  return cases ?? "moves";
}
export function filterCases(
  view: CasesView,
  opts: { cfg: string | null; view: CaseViewKey; rank: DrillQuery["rank"] }
): { rows: CaseRow[]; counts: Record<CaseViewKey, number> } {
  const aCovered = view.aDays > 0;
  const pool =
    opts.cfg === null
      ? view.cells
      : view.cells.filter((c) => `${c.envId}:${c.envVarsId}` === opts.cfg);
  const counts = Object.fromEntries(
    CASE_VIEW_ORDER.map((v) => [
      v,
      pool.filter((r) => viewTest(v, r, opts.rank)).length,
    ])
  ) as Record<CaseViewKey, number>;
  const rows = pool
    .filter((r) => viewTest(opts.view, r, opts.rank))
    .sort(
      (x, y) =>
        viewKey(opts.view, x, opts.rank, aCovered) -
        viewKey(opts.view, y, opts.rank, aCovered)
    );
  return { rows, counts };
}

// "their test time 80 h → 19 h a day: −35 h from fewer runs, −25 h from time
// per run".
export function casesSummary(rows: readonly CaseRow[]): {
  tA: number | null;
  tB: number;
  effVol: number | null;
  effRun: number | null;
} {
  let tA: number | null = 0;
  let tB = 0;
  let effVol: number | null = 0;
  let effRun: number | null = 0;
  for (const r of rows) {
    tA = tA === null || r.tA === null ? null : tA + r.tA;
    tB += r.tB;
    effVol = effVol === null || r.effVol === null ? null : effVol + r.effVol;
    effRun = effRun === null || r.effRun === null ? null : effRun + r.effRun;
  }
  return { tA, tB, effVol, effRun };
}

// Configurations grouped under their environment, largest B first.
export function configGroups(view: CasesView): {
  envId: string;
  environment: EnvironmentRecord | null;
  configs: CaseRow[];
}[] {
  const groups = new Map<
    string,
    { envId: string; environment: EnvironmentRecord | null; configs: CaseRow[] }
  >();
  for (const c of view.configs) {
    let g = groups.get(c.envId);
    if (g === undefined) {
      g = { envId: c.envId, environment: c.environment, configs: [] };
      groups.set(c.envId, g);
    }
    g.configs.push(c);
  }
  const size = (g: { configs: CaseRow[] }) =>
    g.configs.reduce((t, c) => t + c.tB + (c.tA ?? 0), 0);
  return Array.from(groups.values())
    .map((g) => ({
      ...g,
      configs: [...g.configs].sort(
        (x, y) => y.tB + (y.tA ?? 0) - (x.tB + (x.tA ?? 0))
      ),
    }))
    .sort((x, y) => size(y) - size(x));
}

export function configName(envVars: EnvVarsRecord | null): string {
  if (envVars === null) return "unknown";
  return configToken(envVars)?.text ?? "—";
}

// Durations as the test level writes them: "2.2 s", "43 min", "1.5 h".
export function durText(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "–";
  if (seconds < 10) return `${Number(seconds.toFixed(1))} s`;
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${Number((seconds / 3600).toFixed(1))} h`;
}
export function shareText(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "–";
  if (v > 0 && v < 0.01) return "<1%";
  return `${Math.round(v * 100)}%`;
}
export function countText(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "–";
  return v >= 10 || Number.isInteger(v)
    ? Math.round(v).toLocaleString("en-US")
    : v.toFixed(1);
}
export function testHoursText(v: number | null): string {
  return v === null ? "–" : fineAmountLabel("hours", v);
}

// A file's lanes (by=lane children "env_id|workflow") grouped by environment:
// one row per environment, named by the tokens not every lane shares;
// the shared tokens are lifted into one line.
export interface LaneGroup {
  envId: string;
  environment: EnvironmentRecord | null;
  name: string;
  row: DrillRow; // the environment's sum over its workflows
  children: DrillRow[];
}
export function laneGroups(view: LevelView): {
  common: string[];
  groups: LaneGroup[];
} {
  const byEnv = new Map<string, DrillRow[]>();
  for (const r of view.rows) {
    if (r.hidden) continue;
    const env = r.info.environment?.id ?? r.key.split("|")[0];
    byEnv.set(env, [...(byEnv.get(env) ?? []), r]);
  }
  const environments = Array.from(byEnv.values())
    .map((rows) => rows[0].info.environment)
    .filter((e): e is EnvironmentRecord => !!e);
  const common = commonTokens(environments);
  const groups = Array.from(byEnv.entries()).map(([envId, rows]) => {
    const environment = rows[0].info.environment ?? null;
    const tokens = environment
      ? environmentTokenTexts(environment).filter((t) => !common.includes(t))
      : [];
    const sum = sumRows(
      view,
      rows.map((r) => r.key)
    );
    const name = environment
      ? tokens.join(" · ") || environmentText(environment)
      : `environment ${envId}`;
    return {
      envId,
      environment,
      name,
      row: { ...sum, key: envId, name, detail: "" },
      children: rows,
    };
  });
  return { common, groups };
}
