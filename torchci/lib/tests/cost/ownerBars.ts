import {
  addDays,
  type Compare,
  type ComparePreset,
  type CostOwners,
  type DayRange,
  type Pill,
  type Pricer,
  type TrendContext,
  type TrendsQuery,
  type Unit,
} from "lib/api/tests/cost/contracts";
import {
  appendPill,
  divisorsOf,
  dropPill,
  type Figures,
  type SideDivisors,
  sideTotal,
  type SideTotal,
  swapPill,
} from "lib/tests/cost/drill";
import { rateLabel } from "lib/tests/cost/query";
import {
  BUCKET_LABELS,
  computeView,
  type CostChoices,
  type CostView,
  isBucket,
  knownChoices,
  type PreparedHours,
  prepareRunnerHours,
} from "lib/tests/cost/runnerHours";
import {
  comparePresets,
  dataDays,
  presetPatch,
  presetRanges,
  rangeText,
  sameRange,
  selectionPatch,
} from "lib/tests/cost/select";

// The owner bars over B (GET /api/tests/cost/owners), as pure functions of
// the answer, the trail and the rates: the owners largest first, each bar
// split by machine in the machines' fixed order, the machine key, the
// runners of a row or a machine, the keys' days, and the total as the
// drill's head sums B. The scope is the server's (the page's
// workflows); the trail's owner and machine only highlight, and nothing
// re-sorts or rescales when they do. Hours whose machine is estimated from a
// runner label are drawn striped in their machine's paint.

export const OTHER_MACHINES = "Other machines";
export const UNATTRIBUTED_ROW = "Unattributed";
// How many owners get a row before "N more owners".
export const TOP_OWNERS = 15;
const BUCKET_ORDER = Object.keys(BUCKET_LABELS);

// The keys on the band, setting A and B for the whole page. Last day and
// Last 7 days put Trends' dod and 7v7 presets in force (relative links);
// Last 3 days has no preset of its own, so it writes the days themselves.
export interface OwnerPreset {
  key: string;
  label: string;
  preset: ComparePreset | null;
  days: number;
}
export const OWNER_PRESETS: OwnerPreset[] = [
  { key: "dod", label: "Last day", preset: "dod", days: 1 },
  { key: "3d", label: "Last 3 days", preset: null, days: 3 },
  { key: "7v7", label: "Last 7 days", preset: "7v7", days: 7 },
];

// The last n whole days as B, ending where 7v7's B does, and the n before
// as A.
export function lastDays(
  n: number,
  ctx: TrendContext
): { a: DayRange; b: DayRange } {
  const last = presetRanges("7v7", ctx).b.to;
  const b = { from: addDays(last, -(n - 1)), to: last };
  return { a: { from: addDays(b.from, -n), to: addDays(b.from, -1) }, b };
}

export interface OwnerPresetChoice extends OwnerPreset {
  a: DayRange;
  b: DayRange;
  available: boolean;
  // A disabled key's reason, or A and B.
  title: string;
}

// Each key's days and whether they all have data, as Trends' presets read.
export function ownerPresetChoices(ctx: TrendContext): OwnerPresetChoice[] {
  const presets = comparePresets(ctx);
  return OWNER_PRESETS.map((p) => {
    const preset = presets.find((c) => c.id === p.preset);
    if (preset !== undefined) {
      const { a, b, available, title } = preset;
      return { ...p, a, b, available, title };
    }
    const { a, b } = lastDays(p.days, ctx);
    const available =
      dataDays(ctx, a) === p.days && dataDays(ctx, b) === p.days;
    return {
      ...p,
      a,
      b,
      available,
      title: available
        ? `A: ${rangeText(a)} · B: ${rangeText(b)}`
        : `Needs ${rangeText({ from: a.from, to: b.to }, false)}; ${
            ctx.firstDay === null ? "no data yet" : "not enough data yet"
          }`,
    };
  });
}

// Lit while A and B are the key's days, in any rollup.
export const ownerPresetInForce = (c: OwnerPresetChoice, compare: Compare) =>
  sameRange(compare.a, c.a) && sameRange(compare.b, c.b);

// The URL patch a key writes. A preset's is presetPatch's; the others write
// the custom A and B a pick in Trends would (cmp cleared), in the day
// rollup, Show its default when the rollup changes. Those pin their dates
// in a link, where a preset's stay relative.
export function ownerPresetPatch(
  c: OwnerPresetChoice,
  q: TrendsQuery,
  ctx: TrendContext
): Pick<TrendsQuery, "rollup" | "show" | "cmp" | "a" | "b"> {
  if (c.preset !== null) return presetPatch(c.preset, q, ctx);
  const sel = { rollup: "day" as const, a: c.a, b: c.b, preset: null };
  return {
    ...selectionPatch(sel, ctx),
    show: q.rollup === "day" ? q.show : null,
  };
}

// The two reasons an hour reaches no owner, where the chain job, test file,
// owner breaks: what each bucket is, and what it holds.
export const BUCKET_INFO: Record<string, { what: string; holds: string[] }> = {
  "unattributed:no_owner": {
    what: "Tests in files without an owner.",
    holds: ["C++ test binaries", "Python files not in the owners list"],
  },
  "unattributed:no_test_reports": {
    what: "Test jobs without test reports, so their test files are unknown.",
    holds: [
      "Benchmarks and custom test scripts",
      "Reports not uploaded or not ingested",
      "Jobs cancelled before uploading",
    ],
  },
};

// A bucket's definition, for its (i): a line, then what it holds as a list.
export function bucketInfo(bucket: string): string {
  const info = BUCKET_INFO[bucket];
  return info === undefined
    ? ""
    : [
        `${BUCKET_LABELS[bucket]}: ${info.what}`,
        ...info.holds.map((h) => `• ${h}`),
      ].join("\n");
}

// One row of the bars: an owner, the owners past the top folded together
// (or the row folding them back), the unattributed hours, or one bucket of
// them listed under it.
export interface OwnerRow {
  key: string;
  label: string;
  owners: string[];
  hours: number;
  kind: "owner" | "more" | "less" | "bucket" | "member";
}

// The scope's owners largest first, the top ones named and every
// highlighted one in its own row wherever it ranks, the rest folded into
// "N more owners" (listed while expanded), then the unattributed hours in
// one row, its buckets listed under it while open. ran says which owners
// have runner-hours: in $, an owner with hours keeps its row at $0.
export function ownerRows(
  view: CostView,
  options: {
    expanded: boolean;
    bucketsOpen: boolean;
    ran?: (_owner: string) => boolean;
    top?: number;
  }
): OwnerRow[] {
  const { expanded, bucketsOpen, top = TOP_OWNERS } = options;
  const ran =
    options.ran ?? ((owner: string) => (view.ownerScope.get(owner) ?? 0) > 0);
  const owners = Array.from(view.ownerScope)
    .filter(([owner]) => !isBucket(owner) && ran(owner))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = owners.filter(
    ([owner], i) => expanded || i < top || view.owners.has(owner)
  );
  const rows: OwnerRow[] = shown.map(([owner, h]) => ({
    key: owner,
    label: owner,
    owners: [owner],
    hours: h,
    kind: "owner",
  }));
  const shownSet = new Set(shown.map(([owner]) => owner));
  const rest = owners.filter(([owner]) => !shownSet.has(owner));
  if (rest.length > 0) {
    rows.push({
      key: "more",
      label: `${rest.length} more ${rest.length === 1 ? "owner" : "owners"}`,
      owners: rest.map(([owner]) => owner),
      hours: rest.reduce((a, [, h]) => a + h, 0),
      kind: "more",
    });
  } else if (expanded && owners.length > top) {
    rows.push({
      key: "less",
      label: "Show fewer",
      owners: [],
      hours: 0,
      kind: "less",
    });
  }
  const present = BUCKET_ORDER.filter(ran);
  const hoursOf = (b: string) => view.ownerScope.get(b) ?? 0;
  if (present.length > 0) {
    rows.push({
      key: "unattributed",
      label: UNATTRIBUTED_ROW,
      owners: present,
      hours: present.reduce((a, b) => a + hoursOf(b), 0),
      kind: "bucket",
    });
    if (bucketsOpen) {
      for (const b of present) {
        rows.push({
          key: b,
          label: BUCKET_LABELS[b],
          owners: [b],
          hours: hoursOf(b),
          kind: "member",
        });
      }
    }
  }
  return rows;
}

// A row's hours by machine in the scope, or with estimated, only those
// whose machine is estimated from a runner label.
export function rowMix(
  prepared: PreparedHours,
  view: CostView,
  owners: readonly string[],
  estimated = false
): Float64Array {
  const mix = new Float64Array(prepared.machines.length);
  const source = estimated ? view.ownerEstimated : view.ownerMachines;
  for (const owner of owners) {
    source.get(owner)?.forEach((h, m) => (mix[m] += h));
  }
  return mix;
}

// How a piece of a bar is painted: a machine's hue, the grey of the other
// machines, Unknown machine's grey stripes, the accent of a highlighted
// machine with no hue of its own, the pale rest of a highlighted bar, or
// any of the machine paints striped where the machine is estimated.
export type BasePaint =
  | { kind: "machine"; machine: number }
  | { kind: "other" }
  | { kind: "not_probed" }
  | { kind: "accent" }
  | { kind: "pale" };
export type BarPaint = BasePaint | { kind: "estimated"; of: BasePaint };

export interface Segment {
  key: string;
  label: string;
  hours: number;
  paint: BarPaint;
  // The machines the piece covers.
  machines: number[];
}

// A machine's paint: its hue among the colored, else Unknown machine's
// hatch, else the accent while highlighted and the other machines' grey
// otherwise, so a highlighted machine never reads as one of the others.
export function paintOf(
  prepared: PreparedHours,
  m: number,
  highlighted = false
): BasePaint {
  if (m === prepared.notProbed) return { kind: "not_probed" };
  if (prepared.colored.includes(m)) return { kind: "machine", machine: m };
  return highlighted ? { kind: "accent" } : { kind: "other" };
}

// A machine's piece, split in two where part of its hours have an estimated
// machine: the reported hours in the machine's paint, then the estimated
// ones in the same paint, striped.
function machinePieces(
  key: string,
  label: string,
  hours: number,
  estimated: number,
  paint: BasePaint,
  machines: number[]
): Segment[] {
  const out: Segment[] = [];
  if (hours - estimated > 1e-9) {
    out.push({ key, label, hours: hours - estimated, paint, machines });
  }
  if (estimated > 1e-9) {
    out.push({
      key: `${key} (estimated)`,
      label: `${label} (est.)`,
      hours: estimated,
      paint: { kind: "estimated", of: paint },
      machines,
    });
  }
  return out;
}

// A bar's pieces in the machines' fixed order: the colored machines, then
// the others together, then Unknown machine, each split into reported and
// estimated hours. With machines highlighted, those machines' pieces come
// first, each in its paint (an uncolored machine in the accent), and the
// rest of the bar is one pale piece, so the highlighted hours line up at the
// start of every bar.
export function segments(
  prepared: PreparedHours,
  mix: Float64Array,
  highlighted: Set<number>,
  estimated: Float64Array = new Float64Array(mix.length)
): Segment[] {
  const order = prepared.machineOrder;
  const piece = (m: number): Segment[] =>
    machinePieces(
      prepared.machines[m],
      prepared.machines[m],
      mix[m],
      estimated[m] ?? 0,
      paintOf(prepared, m, highlighted.has(m)),
      [m]
    );
  if (highlighted.size > 0) {
    const on = order
      .filter((m) => highlighted.has(m) && mix[m] > 0)
      .flatMap(piece);
    const restMachines = order.filter((m) => !highlighted.has(m));
    const rest = restMachines.reduce((a, m) => a + mix[m], 0);
    return rest > 0
      ? [
          ...on,
          {
            key: "rest",
            label: "other machines",
            hours: rest,
            paint: { kind: "pale" },
            machines: restMachines,
          },
        ]
      : on;
  }
  const pieces = order
    .filter((m) => prepared.colored.includes(m) && mix[m] > 0)
    .flatMap(piece);
  const others = order.filter(
    (m) => m !== prepared.notProbed && !prepared.colored.includes(m)
  );
  const other = others.reduce((a, m) => a + mix[m], 0);
  if (other > 0) {
    pieces.push(
      ...machinePieces(
        OTHER_MACHINES,
        OTHER_MACHINES,
        other,
        others.reduce((a, m) => a + (estimated[m] ?? 0), 0),
        { kind: "other" },
        others
      )
    );
  }
  if (prepared.notProbed >= 0 && mix[prepared.notProbed] > 0)
    pieces.push(...piece(prepared.notProbed));
  return pieces;
}

// The highlighted machines' hours in a mix.
export function highlightedHours(
  mix: Float64Array,
  highlighted: Set<number>
): number {
  let hours = 0;
  for (const m of highlighted) hours += mix[m] ?? 0;
  return hours;
}

// One row of the machine key: a colored machine, the other machines
// together (with their members listed beneath while open), or Unknown
// machine.
export interface KeyRow {
  key: string;
  label: string;
  machines: number[];
  hours: number;
  // The highlighted owners' hours on these machines.
  highlighted: number;
  paint: BasePaint;
  kind: "machine" | "group" | "member";
}

// ran says which machines have runner-hours: in $, a machine with hours
// keeps its row at $0.
export function machineKeyRows(
  prepared: PreparedHours,
  view: CostView,
  open: boolean,
  ran: (_machine: number) => boolean = (m) => view.machineScope[m] > 0
): KeyRow[] {
  const s = view.machineScope;
  const row = (m: number, kind: KeyRow["kind"]): KeyRow => ({
    key: prepared.machines[m],
    label: prepared.machines[m],
    machines: [m],
    hours: s[m],
    highlighted: view.machineHighlighted[m],
    paint: paintOf(prepared, m, view.machines.has(m)),
    kind,
  });
  const rows = prepared.machineOrder
    .filter((m) => prepared.colored.includes(m) && ran(m))
    .map((m) => row(m, "machine"));
  const others = prepared.machineOrder.filter(
    (m) => m !== prepared.notProbed && !prepared.colored.includes(m) && ran(m)
  );
  if (others.length > 0) {
    rows.push({
      key: OTHER_MACHINES,
      label: `${OTHER_MACHINES} (${others.length})`,
      machines: others,
      hours: others.reduce((a, m) => a + s[m], 0),
      highlighted: others.reduce((a, m) => a + view.machineHighlighted[m], 0),
      paint: { kind: "other" },
      kind: "group",
    });
    if (open) rows.push(...others.map((m) => row(m, "member")));
  }
  if (prepared.notProbed >= 0 && ran(prepared.notProbed)) {
    rows.push(row(prepared.notProbed, "machine"));
  }
  return rows;
}

// The page's machine hues on B's answer: colored, the 7-day answer's hued
// machines by name in hue order (what the trend bars use), becomes their
// indexes in B, a machine B lacks leaving its hue unused (-1). Without the
// page's, B keeps its own.
export function withHues(
  prepared: PreparedHours,
  colored?: readonly string[]
): PreparedHours {
  if (colored === undefined) return prepared;
  return {
    ...prepared,
    colored: colored.map((name) => prepared.machines.indexOf(name)),
  };
}

// The trail's owner and machine as the bars' highlight; the workflow scope
// is the server's.
export function trailChoices(trail: readonly Pill[]): CostChoices {
  const of = (dim: Pill["dim"]) =>
    trail.filter((p) => p.dim === dim).map((p) => p.value);
  return { workflows: [], owners: of("o"), machines: of("m") };
}

// A click on an owner or machine: off when it is the pill of its dimension,
// swapped in for another value of it (deeper pills kept), else appended.
export function togglePill(trail: readonly Pill[], pill: Pill): Pill[] {
  const k = trail.findIndex((p) => p.dim === pill.dim);
  if (k < 0) return appendPill(trail, pill);
  return trail[k].value === pill.value
    ? dropPill(trail, k)
    : swapPill(trail, k, pill.value);
}

// Each row's $ from its day cells, each day at that day's rate for the
// row's label (the drill's piece=day pricing); hours on a day or label
// without a rate stay unpriced, never priced at another day's rate.
export function priceOwners(
  answer: Pick<CostOwners, "rows" | "days" | "cells">,
  pricer: Pricer
): { usd: Float64Array; unpriced: Float64Array; hours: Float64Array } {
  const n = answer.rows.length;
  const usd = new Float64Array(n);
  const unpriced = new Float64Array(n);
  const hours = new Float64Array(n);
  for (const [d, r, h] of answer.cells) {
    const row = answer.rows[r];
    const day = answer.days[d];
    if (row === undefined || day === undefined) continue;
    hours[r] += h;
    const rate = pricer.rate(row.label, day);
    if (rate === null) unpriced[r] += h;
    else usd[r] += h * rate;
  }
  return { usd, unpriced, hours };
}

export interface OwnerBarsModel {
  answer: CostOwners;
  unit: Unit;
  // In $, what priced it.
  pricer: Pricer | null;
  // In the unit: $ rows keep the hours' machine order and hues.
  prepared: PreparedHours;
  view: CostView;
  // In runner-hours: which owners and machines ran (they keep rows at $0).
  hours: CostView;
  // B's total as the drill's head sums it, and what it divides by.
  total: SideTotal;
  divisors: SideDivisors;
  unpricedH: number;
  // Each machine's runner labels, the most runner-hours over B first: their
  // order and shade in the machine key, whatever the unit or highlight.
  runnerOrder: string[][];
}

const sum = (xs: Float64Array) => xs.reduce((a, b) => a + b, 0);

// The bars of one answer: in hours, or with a pricer in $ (piece=day cells),
// highlighted by the trail, hued as the page hues machines.
export function ownerBarsModel(
  answer: CostOwners,
  options: {
    pricer: Pricer | null;
    colored?: readonly string[];
    trail: readonly Pill[];
  }
): OwnerBarsModel {
  const { pricer } = options;
  const unit: Unit = pricer === null ? "hours" : "usd";
  const hp = withHues(prepareRunnerHours(answer), options.colored);
  const choices = knownChoices(hp, trailChoices(options.trail));
  const hours = computeView(hp, choices);
  const divisors = divisorsOf(
    {
      days: answer.days,
      pushes: answer.days.map(() => 0),
      filling: answer.filling,
    },
    { from: answer.from, to: answer.to },
    pricer
  );
  const figures: Figures = {
    h: hours.scopeTotal,
    mainH: 0,
    usd: 0,
    mainUsd: 0,
    unpricedH: 0,
    unpricedMainH: 0,
    approx: false,
  };
  const runnerOrder = runnerOrderOf(answer, hp);
  if (pricer === null) {
    return {
      answer,
      unit,
      pricer,
      prepared: hp,
      view: hours,
      hours,
      total: sideTotal(figures, divisors, unit),
      divisors,
      unpricedH: 0,
      runnerOrder,
    };
  }
  const priced = priceOwners(answer, pricer);
  const prepared: PreparedHours = {
    ...hp,
    rowHours: priced.usd,
    total: sum(priced.usd),
  };
  const view = computeView(prepared, choices);
  // h from the cells, so "every hour unpriced" reads as no rates, not $0.
  figures.h = sum(priced.hours);
  figures.usd = view.scopeTotal;
  figures.unpricedH = sum(priced.unpriced);
  return {
    answer,
    unit,
    pricer,
    prepared,
    view,
    hours,
    total: sideTotal(figures, divisors, unit),
    divisors,
    unpricedH: figures.unpricedH,
    runnerOrder,
  };
}

function runnerOrderOf(
  answer: Pick<CostOwners, "rows">,
  prepared: PreparedHours
): string[][] {
  const hours = prepared.machines.map(() => new Map<string, number>());
  answer.rows.forEach((row, i) => {
    const byLabel = hours[prepared.rowMachine[i]];
    byLabel.set(row.label, (byLabel.get(row.label) ?? 0) + row.runner_hours);
  });
  return hours.map((byLabel) =>
    Array.from(byLabel)
      .filter(([, h]) => h > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label]) => label)
  );
}

// A machine's or a runner's figures over B: its runner-hours, those without
// a rate (on a day no period covers, or a label its period lacks), and the
// figure in the unit, the hours or their $ day by day. In $, rate is the $
// per priced runner-hour (null with none priced), approx where it is an
// average: a machine's always, a runner's where its rate changed over B.
export interface RunnerFigures {
  hours: number;
  unpriced: number;
  value: number;
  rate: number | null;
  approx: boolean;
}
// A runner: the runner labels a job asked for, what a rates file prices.
export interface RunnerLine extends RunnerFigures {
  label: string;
}
export interface MachineRunners extends RunnerFigures {
  machine: number;
  runners: RunnerLine[];
}

// A $/h as the runner lists write it: "~" on an average, "no rate" where
// none of its hours has one.
export function rateText(f: RunnerFigures): string {
  return f.rate === null
    ? "no rate"
    : `${f.approx ? "~" : ""}${rateLabel(f.rate)}`;
}

// Several machines' figures as one (Other machines): summed, their $/h
// their $ over their priced hours.
export function sumFigures(fs: readonly RunnerFigures[]): RunnerFigures {
  const hours = fs.reduce((a, f) => a + f.hours, 0);
  const unpriced = fs.reduce((a, f) => a + f.unpriced, 0);
  const value = fs.reduce((a, f) => a + f.value, 0);
  const priced = fs.some((f) => f.rate !== null);
  return {
    hours,
    unpriced,
    value,
    rate: priced ? value / (hours - unpriced) : null,
    approx: true,
  };
}

// Whether some of a runner's hours have no rate while the rest do.
export const partlyUnpriced = (f: RunnerFigures): boolean =>
  f.rate !== null && f.unpriced > 0;

interface Tally {
  hours: number;
  unpriced: number;
  value: number;
  first: number | null;
  mixed: boolean;
}
const tally = (): Tally => ({
  hours: 0,
  unpriced: 0,
  value: 0,
  first: null,
  mixed: false,
});
function count(t: Tally, h: number, rate: number | null | undefined) {
  t.hours += h;
  // undefined: in hours, where the hours are the figure.
  if (rate === undefined) t.value += h;
  else if (rate === null) t.unpriced += h;
  else {
    t.value += h * rate;
    if (t.first === null) t.first = rate;
    else if (rate !== t.first) t.mixed = true;
  }
}
const figuresOf = (t: Tally): RunnerFigures => ({
  hours: t.hours,
  unpriced: t.unpriced,
  value: t.value,
  // One rate as given, so an exact rate adds no float error.
  rate:
    t.first === null
      ? null
      : t.mixed
      ? t.value / (t.hours - t.unpriced)
      : t.first,
  approx: t.mixed,
});

// Each of the model's rows with hours as fn(row, hours, rate): in $ once per
// day cell at that day's rate (null without one), in hours once per row.
function eachHour(
  model: OwnerBarsModel,
  owners: readonly string[] | null,
  fn: (_row: number, _h: number, _rate?: number | null, _day?: string) => void
) {
  const { answer, pricer } = model;
  const wanted = owners === null ? null : new Set(owners);
  const keep = (r: number, h: number) =>
    h > 0 &&
    answer.rows[r] !== undefined &&
    (wanted === null || wanted.has(answer.rows[r].owner));
  if (pricer === null) {
    answer.rows.forEach((row, r) => {
      if (keep(r, row.runner_hours)) fn(r, row.runner_hours);
    });
    return;
  }
  for (const [d, r, h] of answer.cells) {
    const day = answer.days[d];
    if (day === undefined || !keep(r, h)) continue;
    fn(r, h, pricer.rate(answer.rows[r].label, day), day);
  }
}

const larger = (a: RunnerFigures, b: RunnerFigures) =>
  b.value - a.value || b.hours - a.hours;

// What some owners' hours ran on (every owner's with null): their machines,
// the largest in the unit first and Unknown machine last, each with its
// runners largest first. The runners add up to their machine, the machines
// to the owners' figure.
export function runnerBreakdown(
  model: OwnerBarsModel,
  owners: readonly string[] | null
): MachineRunners[] {
  const { answer, prepared } = model;
  const byMachine = new Map<
    number,
    { all: Tally; labels: Map<string, Tally> }
  >();
  eachHour(model, owners, (r, h, rate) => {
    const m = prepared.rowMachine[r];
    let entry = byMachine.get(m);
    if (entry === undefined) {
      entry = { all: tally(), labels: new Map() };
      byMachine.set(m, entry);
    }
    count(entry.all, h, rate);
    const label = answer.rows[r].label;
    let line = entry.labels.get(label);
    if (line === undefined) {
      line = tally();
      entry.labels.set(label, line);
    }
    count(line, h, rate);
  });
  const name = (m: number) => prepared.machines[m];
  return Array.from(byMachine, ([machine, e]) => ({
    // A machine's $/h is its runners' average, even at one rate.
    ...figuresOf(e.all),
    approx: true,
    machine,
    runners: Array.from(e.labels, ([label, t]) => ({
      ...figuresOf(t),
      label,
    })).sort((a, b) => larger(a, b) || a.label.localeCompare(b.label)),
  })).sort(
    (a, b) =>
      Number(a.machine === prepared.notProbed) -
        Number(b.machine === prepared.notProbed) ||
      larger(a, b) ||
      name(a.machine).localeCompare(name(b.machine))
  );
}

// In $, the runners with hours on B's priced days (days a rates period
// covers) and a rate on none of them, the most such hours first; their
// hours, and the runner-hours on priced days they are a share of. Days no
// period covers are the priced-days note's, not theirs.
export function noRateRunners(
  model: OwnerBarsModel,
  owners: readonly string[] | null
): { runners: { label: string; hours: number }[]; hours: number; of: number } {
  const { answer, pricer } = model;
  const byLabel = new Map<string, { hours: number; priced: number }>();
  let of = 0;
  eachHour(model, owners, (r, h, rate, day) => {
    if (pricer === null || day === undefined) return;
    if (pricer.dayKind(day) === "gap") return;
    of += h;
    const label = answer.rows[r].label;
    const line = byLabel.get(label) ?? { hours: 0, priced: 0 };
    line.hours += h;
    if (rate !== null && rate !== undefined) line.priced += h;
    byLabel.set(label, line);
  });
  const runners = Array.from(byLabel)
    .filter(([, l]) => l.priced === 0)
    .map(([label, l]) => ({ label, hours: l.hours }))
    .sort((a, b) => b.hours - a.hours || a.label.localeCompare(b.label));
  return { runners, hours: runners.reduce((a, r) => a + r.hours, 0), of };
}
