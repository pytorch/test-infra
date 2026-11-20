import type { Theme } from "@mui/material/styles";
import {
  type BarsScope,
  type DayRange,
  namedOwners,
  NO_OWNER,
  NO_TEST_REPORTS,
  type Per,
  type Pricer,
  type ScopeBy,
  type Unit,
  UNKNOWN_MACHINE,
} from "lib/api/tests/cost/contracts";
import {
  machineHue,
  noOwnerColor,
  otherMachinesColor,
  ownerFill,
} from "lib/tests/cost/colors";
import type { Folded } from "lib/tests/cost/fold";
import { ownerLabel, type PreparedHours } from "lib/tests/cost/runnerHours";

// The bars' stacks: each bar split by what the bars' scope
// lists, in a fixed order (never re-ranked), each value per day with data or
// per commit, in hours or $ priced per day cell (h × rate(label, day)).
//   owner root (/trend) or a scope listing owners: 5 named owners, Other
//     owners, No owner, No test reports (owner hues);
//   a scope listing machines: the colored machines, Other machines, Unknown
//     machine hatched (machine hues);
//   files, lanes, labels: one series in the leaf's color; a hovered drill row
//     draws its share at the baseline over grey.

export type Paint =
  | { kind: "owner"; position: number }
  | { kind: "other_owners" }
  | { kind: "no_owner" }
  | { kind: "no_reports" }
  | { kind: "machine"; position: number }
  | { kind: "other_machines" }
  | { kind: "unknown_machine" }
  | { kind: "accent" }
  | { kind: "pale" };

export interface StackKey {
  id: string;
  label: string;
  paint: Paint;
}

export interface StackOptions {
  repo: string;
  unit: Unit; // "usd" only with a pricer
  per: Per;
  pricer: Pricer | null;
  scope: BarsScope;
  // Machines with a hue, in hue order (prepared.colored's names). Empty: the
  // series' 7 largest by name.
  colored: readonly string[];
}

// Per-day sums over every cell of the answer (any day it holds), so A, B and
// the strip's spans sum days without walking cells.
export interface DayTotals {
  h: Float64Array; // runner-hours
  main: Float64Array; // push:main hours
  usd: Float64Array; // $ of h
  usdMain: Float64Array; // $ of main
  unpriced: Float64Array; // h without a rate ($ mode)
  unpricedMain: Float64Array;
  priced: Uint8Array; // 1 = the day has a rate period (always 1 in hours)
}

export interface Stacks {
  unit: Unit;
  per: Per;
  by: ScopeBy;
  keys: StackKey[]; // bottom to top
  value: Float64Array[]; // [key][bar] in the unit, per day or per commit
  total: Float64Array; // Σ keys per bar
  divisor: Float64Array; // per bar: days with data (priced days in $) or pushes
  hours: Float64Array; // per bar: runner-hours behind the bar (raw, per day or main)
  unpriced: Float64Array; // per bar: raw hours with no rate
  pricedDays: Int32Array; // per bar: days with data and a rate period
  keyTotals: Float64Array; // Σ value per key over the bars (legend)
  keyGroup: Int32Array; // cells.keys → key index (-1: none)
  lit: number | null; // the key a hovered drill row lights (drawn at the baseline)
  days: DayTotals;
  // A cell's $ factor: its rate on its day ($), 1 (hours), null (unpriced).
  factor(_cell: number): number | null;
}

const POSITIONS = [0, 1, 2, 3, 4, 5, 6];

// A paint as a fill: its color, and whether it is drawn as 45° stripes.
export function paintFill(
  theme: Theme,
  paint: Paint
): { color: string; hatch: boolean } {
  switch (paint.kind) {
    case "owner":
      return {
        color: ownerFill(theme, paint.position) ?? theme.palette.primary.main,
        hatch: false,
      };
    case "machine":
      return {
        color:
          machineHue(
            theme,
            { colored: POSITIONS } as unknown as PreparedHours,
            paint.position
          ) ?? otherMachinesColor(theme),
        hatch: false,
      };
    case "other_owners":
    case "other_machines":
      return { color: otherMachinesColor(theme), hatch: false };
    case "no_owner":
      return { color: noOwnerColor(theme), hatch: false };
    case "no_reports":
    case "unknown_machine":
      return { color: theme.palette.grey[500], hatch: true };
    case "accent":
      return { color: theme.palette.primary.main, hatch: false };
    case "pale":
      // The rest under a hovered row: grey enough to read at 50% outside A/B.
      return {
        color:
          theme.palette.mode === "dark"
            ? theme.palette.grey[700]
            : theme.palette.grey[300],
        hatch: false,
      };
  }
}

function rankKeys(folded: Folded): string[] {
  const { cells } = folded;
  const sums = new Float64Array(cells.keys.length);
  for (let c = 0; c < cells.cellH.length; c++) {
    sums[cells.cellKey[c]] += cells.cellH[c];
  }
  return cells.keys
    .map((k, i) => [k, sums[i]] as const)
    .sort((x, y) => y[1] - x[1])
    .map(([k]) => k);
}

// The leaf's paint: the last owner or machine pill, a machine in its hue, an
// owner in the bars' (primary for owners outside the five).
function leafPaint(
  scope: BarsScope,
  named: readonly string[],
  colored: readonly string[]
): Paint {
  const pill = [...scope.trail].reverse().find((p) => p.dim !== "f");
  if (pill === undefined) return { kind: "accent" };
  if (pill.dim === "m") {
    if (pill.value === UNKNOWN_MACHINE) return { kind: "unknown_machine" };
    const i = colored.indexOf(pill.value);
    return i < 0 ? { kind: "accent" } : { kind: "machine", position: i };
  }
  return ownerPaint(pill.value, named);
}

function ownerPaint(owner: string, named: readonly string[]): Paint {
  if (owner === NO_OWNER) return { kind: "no_owner" };
  if (owner === NO_TEST_REPORTS) return { kind: "no_reports" };
  const i = named.indexOf(owner);
  return i < 0 ? { kind: "accent" } : { kind: "owner", position: i };
}

function machinePaint(machine: string, colored: readonly string[]): Paint {
  if (machine === UNKNOWN_MACHINE) return { kind: "unknown_machine" };
  const i = colored.indexOf(machine);
  return i < 0 ? { kind: "accent" } : { kind: "machine", position: i };
}

// Keys and each answer key's key, for the bars' scope.
function groupsOf(
  folded: Folded,
  opts: StackOptions
): { by: ScopeBy; keys: StackKey[]; keyGroup: Int32Array; lit: number | null } {
  const { scope } = opts;
  const names = folded.cells.keys;
  const by: ScopeBy = scope.fromTrend ? "o" : scope.by;
  const keyGroup = new Int32Array(names.length).fill(-1);
  const ranked = rankKeys(folded);
  const named = namedOwners(opts.repo, ranked);
  const hovered =
    scope.hover !== null &&
    scope.hover.by === by &&
    scope.hover.children.length > 0
      ? new Set(scope.hover.children)
      : null;
  const keys: StackKey[] = [];
  let lit: number | null = null;
  const add = (key: StackKey) => keys.push(key) - 1;

  let colored = opts.colored;
  if (by === "m" && colored.length === 0) {
    colored = ranked
      .filter((k) => k !== UNKNOWN_MACHINE && k !== "")
      .slice(0, POSITIONS.length)
      .sort();
  }

  if (hovered !== null) {
    const children = [...hovered];
    const label = children
      .map((c) => (c === "" ? "the rest" : ownerLabel(c)))
      .join(", ");
    let paint: Paint;
    if (by === "o" && children.length === 1)
      paint = ownerPaint(children[0], named);
    else if (by === "m" && children.length === 1)
      paint = machinePaint(children[0], colored);
    else if (by === "o" || by === "m") paint = { kind: "accent" };
    else paint = leafPaint(scope, named, colored);
    lit = add({ id: "lit", label, paint });
    names.forEach((k, i) => {
      if (hovered.has(k)) keyGroup[i] = lit!;
    });
  }

  if (by === "o") {
    const index = new Map<string, number>();
    named.forEach((o, i) =>
      index.set(
        o,
        add({ id: o, label: o, paint: { kind: "owner", position: i } })
      )
    );
    const other = add({
      id: "other_owners",
      label: "Other owners",
      paint: { kind: "other_owners" },
    });
    const noOwner = add({
      id: NO_OWNER,
      label: ownerLabel(NO_OWNER),
      paint: { kind: "no_owner" },
    });
    const noReports = add({
      id: NO_TEST_REPORTS,
      label: ownerLabel(NO_TEST_REPORTS),
      paint: { kind: "no_reports" },
    });
    names.forEach((k, i) => {
      if (keyGroup[i] >= 0) return;
      keyGroup[i] =
        index.get(k) ??
        (k === NO_OWNER ? noOwner : k === NO_TEST_REPORTS ? noReports : other);
    });
  } else if (by === "m") {
    const index = new Map<string, number>();
    colored.forEach((m, i) =>
      index.set(
        m,
        add({ id: m, label: m, paint: { kind: "machine", position: i } })
      )
    );
    const other = add({
      id: "other_machines",
      label: "Other machines",
      paint: { kind: "other_machines" },
    });
    const unknown = add({
      id: UNKNOWN_MACHINE,
      label: UNKNOWN_MACHINE,
      paint: { kind: "unknown_machine" },
    });
    names.forEach((k, i) => {
      if (keyGroup[i] >= 0) return;
      keyGroup[i] = index.get(k) ?? (k === UNKNOWN_MACHINE ? unknown : other);
    });
  } else {
    const leaf = add(
      hovered === null
        ? {
            id: "leaf",
            label: scopeName(scope),
            paint: leafPaint(scope, named, colored),
          }
        : { id: "rest", label: "The rest", paint: { kind: "pale" } }
    );
    names.forEach((_, i) => {
      if (keyGroup[i] < 0) keyGroup[i] = leaf;
    });
  }
  return { by, keys, keyGroup, lit };
}

// The bars' scope in words: "inductor on Linux x86_64 avx512".
export function scopeName(scope: BarsScope): string {
  const o = scope.trail.find((p) => p.dim === "o");
  const m = scope.trail.find((p) => p.dim === "m");
  const f = scope.trail.find((p) => p.dim === "f");
  const parts = [
    f?.value.split("/").pop(),
    o === undefined ? undefined : ownerLabel(o.value),
  ].filter((x): x is string => x !== undefined);
  const head = parts.join(" of ");
  if (m === undefined) return head || "All owners";
  return head ? `${head} on ${m.value}` : m.value;
}

export function trendStacks(folded: Folded, opts: StackOptions): Stacks {
  const { cells, bars } = folded;
  const usd = opts.unit === "usd" && opts.pricer !== null;
  const pricer = opts.pricer;
  const { by, keys, keyGroup, lit } = groupsOf(folded, opts);
  const nd = cells.days.length;
  const nl = cells.labels.length;

  // Rates per (label, day), looked up once each.
  const rates = new Float64Array(usd ? nl * nd : 0).fill(Number.NaN);
  const priced = new Uint8Array(nd).fill(1);
  if (usd) {
    cells.days.forEach((d, i) => {
      priced[i] = pricer!.dayKind(d) === "gap" ? 0 : 1;
    });
  }
  const factor = (c: number): number | null => {
    if (!usd) return 1;
    const d = cells.cellDay[c];
    if (d < 0) return null;
    const at = cells.cellLabel[c] * nd + d;
    let r = rates[at];
    if (Number.isNaN(r)) {
      r = pricer!.rate(cells.labels[cells.cellLabel[c]], cells.days[d]) ?? -1;
      rates[at] = r;
    }
    return r < 0 ? null : r;
  };

  const days: DayTotals = {
    h: new Float64Array(nd),
    main: new Float64Array(nd),
    usd: new Float64Array(nd),
    usdMain: new Float64Array(nd),
    unpriced: new Float64Array(nd),
    unpricedMain: new Float64Array(nd),
    priced,
  };
  const nb = bars.length;
  const value = keys.map(() => new Float64Array(nb));
  const hours = new Float64Array(nb);
  const unpriced = new Float64Array(nb);
  const commit = opts.per === "commit";
  for (let c = 0; c < cells.cellH.length; c++) {
    const d = cells.cellDay[c];
    if (d < 0) continue;
    const h = cells.cellH[c];
    const main = cells.cellMain[c];
    const f = factor(c);
    days.h[d] += h;
    days.main[d] += main;
    if (f === null) {
      days.unpriced[d] += h;
      days.unpricedMain[d] += main;
    } else {
      days.usd[d] += h * f;
      days.usdMain[d] += main * f;
    }
    const b = folded.cellBar[c];
    if (b < 0) continue;
    const x = commit ? main : h;
    hours[b] += x;
    if (f === null) unpriced[b] += x;
    else {
      const k = keyGroup[cells.cellKey[c]];
      if (k >= 0) value[k][b] += x * f;
    }
  }

  // Divisors: days with data, or pushes; in $ only the days with rates.
  const divisor = new Float64Array(nb);
  const pricedDays = new Int32Array(nb);
  for (let d = 0; d < nd; d++) {
    const b = folded.dayBar[d];
    if (b < 0 || !priced[d]) continue;
    pricedDays[b]++;
    if (commit) divisor[b] += cells.pushes[d] ?? 0;
  }
  bars.forEach((bar, b) => {
    if (!commit) divisor[b] = usd ? pricedDays[b] : bar.data;
    else if (!usd) divisor[b] = bar.pushes;
  });
  const total = new Float64Array(nb);
  const keyTotals = new Float64Array(keys.length);
  for (let b = 0; b < nb; b++) {
    const div = divisor[b];
    for (let k = 0; k < keys.length; k++) {
      value[k][b] = div > 0 ? value[k][b] / div : 0;
      total[b] += value[k][b];
      keyTotals[k] += value[k][b];
    }
  }
  return {
    unit: usd ? "usd" : "hours",
    per: opts.per,
    by,
    keys,
    value,
    total,
    divisor,
    hours,
    unpriced,
    pricedDays,
    keyTotals,
    keyGroup,
    lit,
    days,
    factor,
  };
}

export interface SpanTotals {
  value: number; // per day or per commit, in the unit
  days: number; // days with data in the range
  pricedDays: number;
  pushes: number;
  pricedPushes: number;
  hours: number; // Σ hours (main hours per commit) in the range
  usd: number; // Σ $ of those hours
  unpriced: number; // Σ of those hours with no rate
}

// A range's totals over the bars' scope (every day the answer holds in it):
// what A's and B's tabs and average lines read, and the strip's spans.
export function spanTotals(
  folded: Folded,
  stacks: Stacks,
  range: DayRange
): SpanTotals {
  const { cells } = folded;
  const commit = stacks.per === "commit";
  const t: SpanTotals = {
    value: 0,
    days: 0,
    pricedDays: 0,
    pushes: 0,
    pricedPushes: 0,
    hours: 0,
    usd: 0,
    unpriced: 0,
  };
  const d = stacks.days;
  cells.days.forEach((day, i) => {
    if (day < range.from || day > range.to) return;
    const pushes = cells.pushes[i] ?? 0;
    t.days++;
    t.pushes += pushes;
    if (d.priced[i]) {
      t.pricedDays++;
      t.pricedPushes += pushes;
    }
    t.hours += commit ? d.main[i] : d.h[i];
    t.usd += commit ? d.usdMain[i] : d.usd[i];
    t.unpriced += commit ? d.unpricedMain[i] : d.unpriced[i];
  });
  const usd = stacks.unit === "usd";
  const sum = usd ? t.usd : t.hours;
  const div = commit
    ? usd
      ? t.pricedPushes
      : t.pushes
    : usd
    ? t.pricedDays
    : t.days;
  t.value = div > 0 ? sum / div : 0;
  return t;
}

// The members of one key on one bar, largest first, in the bar's unit (the
// tooltip's "Other owners" sub-line).
export function keyMembers(
  folded: Folded,
  stacks: Stacks,
  key: number,
  bar: number
): { name: string; value: number }[] {
  const { cells } = folded;
  const sums = new Map<number, number>();
  const commit = stacks.per === "commit";
  for (let i = folded.barOffsets[bar]; i < folded.barOffsets[bar + 1]; i++) {
    const c = folded.barCells[i];
    const k = cells.cellKey[c];
    if (stacks.keyGroup[k] !== key) continue;
    const f = stacks.factor(c);
    if (f === null) continue;
    const x = (commit ? cells.cellMain[c] : cells.cellH[c]) * f;
    sums.set(k, (sums.get(k) ?? 0) + x);
  }
  const div = stacks.divisor[bar];
  return [...sums.entries()]
    .map(([k, v]) => ({ name: cells.keys[k], value: div > 0 ? v / div : 0 }))
    .filter((m) => m.value > 0)
    .sort((x, y) => y.value - x.value);
}

// One bar's whole value per day or per commit, whichever the stacks are not
// (the tooltip's other-unit line); null without a divisor.
export function barValue(
  folded: Folded,
  stacks: Stacks,
  bar: number,
  per: Per
): number | null {
  const { cells } = folded;
  let sum = 0;
  for (let i = folded.barOffsets[bar]; i < folded.barOffsets[bar + 1]; i++) {
    const c = folded.barCells[i];
    const f = stacks.factor(c);
    if (f !== null) {
      sum += (per === "commit" ? cells.cellMain[c] : cells.cellH[c]) * f;
    }
  }
  let div = 0;
  for (let d = 0; d < cells.days.length; d++) {
    if (folded.dayBar[d] !== bar || !stacks.days.priced[d]) continue;
    div += per === "commit" ? cells.pushes[d] ?? 0 : 1;
  }
  return div > 0 ? sum / div : null;
}
