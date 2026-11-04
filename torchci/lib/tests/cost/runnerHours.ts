import type { Contributor, RunnerHours } from "lib/api/tests/cost/types";
import { escapeCSV } from "lib/csvUtils";

// The cost page's sums over GET /api/tests/cost, done in the browser:
// the answer holds every owner, workflow and machine of the window, so a
// change of scope or highlight is a pass over a few thousand rows, not a
// request. Pure functions of the answer and the reader's choices; the
// components only draw what these return.
//
// Three rules hold throughout. The workflow scope is the only choice that
// changes the numbers: owners and machines highlight, and nothing re-sorts
// or rescales when they do. Machines keep one order, the window's largest
// first and Unknown machine last, so stacks never reshuffle. The seven
// largest machines over the window keep their hues whatever is scoped.
// Hours whose machine is estimated from a runner label (test jobs without
// reports) are drawn striped in their machine's paint.

// The machine of runner-hours on runner labels that no job with test
// reports ran on, which the API names "".
export const NOT_PROBED = "Unknown machine";
export const OTHER_MACHINES = "Other machines";
export const SHARED_ROW = "Shared: build and other jobs";
export const UNATTRIBUTED_ROW = "Unattributed";

// How many owners the chart and the matrix name before "N more owners".
export const TOP_OWNERS = 15;
// How many workflows the workflows card lists before "+ N more".
export const TOP_WORKFLOWS = 4;
// How many machines keep a hue of their own.
export const COLORED_MACHINES = 7;
// Cells under this many runner-hours are drawn empty, and machines under it
// over the scope get no column.
export const MIN_CELL_HOURS = 0.5;

export const BUCKET_LABELS: Record<string, string> = {
  "shared:build": "Shared: build jobs",
  "shared:other": "Shared: other jobs (lint, docs, binaries, ...)",
  // No owner first: its rows look like any owner's, then the striped rows
  // of test jobs without reports.
  "unattributed:no_owner": "No owner",
  "unattributed:no_test_reports": "No test reports",
};
const BUCKET_ORDER = Object.keys(BUCKET_LABELS);

// The two reasons an hour reaches no owner, where the chain job, test file,
// owner breaks: what each bucket is, and what makes it shrink.
export const BUCKET_INFO: Record<string, { what: string; shrinks: string }> = {
  "unattributed:no_test_reports": {
    what: "Test jobs that sent no test reports, so which test files ran is unknown: benchmark and custom-script configs, fleets whose reports do not reach the database (XPU), pull requests on a base older than the report format, cancelled jobs.",
    shrinks: "Shrinks as these jobs upload test reports.",
  },
  "unattributed:no_owner": {
    what: "Tests that sent reports, but their file has no owner: C++ test binaries, which have no owners yet, and Python files missing from the owners list.",
    shrinks: "Shrinks as the files get owners.",
  },
};

// A bucket's definition in words, for its (i).
export function bucketInfo(bucket: string): string {
  const info = BUCKET_INFO[bucket];
  return info === undefined
    ? ""
    : `${BUCKET_LABELS[bucket]}: ${info.what} ${info.shrinks}`;
}

export function isBucket(owner: string): boolean {
  return owner.startsWith("shared:") || owner.startsWith("unattributed:");
}

export function ownerLabel(owner: string): string {
  return BUCKET_LABELS[owner] ?? owner;
}

// The answer indexed once: names by index, the rows as parallel
// arrays, the window's totals and the machines' fixed order and hues.
export interface PreparedHours {
  owners: string[];
  // Largest over the window first.
  workflows: string[];
  // As the page names them: NOT_PROBED for the API's empty machine.
  machines: string[];
  family: string[];
  short: string[];
  labels: string[][];
  notProbed: number;
  rowOwner: Int32Array;
  rowWorkflow: Int32Array;
  rowMachine: Int32Array;
  rowHours: Float64Array;
  // 1 where the row's machine is estimated from its runner label.
  rowEstimated: Uint8Array;
  // What the unattributed buckets are made of.
  contributors: Contributor[];
  total: number;
  workflowTotal: Float64Array;
  machineTotal: Float64Array;
  // The window's largest machine first, Not probed last.
  machineOrder: number[];
  // The machines with a hue, in name order, so a change of rank among them
  // does not repaint them; the hue is the theme's for that position.
  colored: number[];
}

export function prepareRunnerHours(answer: RunnerHours): PreparedHours {
  const index = (
    names: string[],
    lookup: Map<string, number>,
    name: string
  ) => {
    let i = lookup.get(name);
    if (i === undefined) {
      i = names.length;
      names.push(name);
      lookup.set(name, i);
    }
    return i;
  };
  const owners: string[] = [];
  const ownerIndex = new Map<string, number>();
  const rawWorkflows: string[] = [];
  const workflowIndex = new Map<string, number>();
  const machines: string[] = [];
  const machineIndex = new Map<string, number>();
  for (const m of answer.machines) index(machines, machineIndex, m.machine);
  const n = answer.rows.length;
  const rowOwner = new Int32Array(n);
  const rawWorkflow = new Int32Array(n);
  const rowMachine = new Int32Array(n);
  const rowHours = new Float64Array(n);
  const rowEstimated = new Uint8Array(n);
  answer.rows.forEach((row, i) => {
    rowEstimated[i] = row.machine_source === "runner_label" ? 1 : 0;
    rowOwner[i] = index(owners, ownerIndex, row.owner);
    rawWorkflow[i] = index(rawWorkflows, workflowIndex, row.workflow);
    rowMachine[i] = index(
      machines,
      machineIndex,
      row.machine === "" ? NOT_PROBED : row.machine
    );
    rowHours[i] = row.runner_hours;
  });

  // Workflows renumbered largest first, so their order is their index.
  const rawTotal = new Float64Array(rawWorkflows.length);
  rawWorkflow.forEach((w, i) => (rawTotal[w] += rowHours[i]));
  const byHours = rawWorkflows
    .map((_, w) => w)
    .sort(
      (a, b) =>
        rawTotal[b] - rawTotal[a] ||
        rawWorkflows[a].localeCompare(rawWorkflows[b])
    );
  const renumber = new Int32Array(rawWorkflows.length);
  byHours.forEach((w, i) => (renumber[w] = i));
  const workflows = byHours.map((w) => rawWorkflows[w]);
  const rowWorkflow = rawWorkflow.map((w) => renumber[w]);
  const workflowTotal = Float64Array.from(byHours.map((w) => rawTotal[w]));

  const machineTotal = new Float64Array(machines.length);
  rowMachine.forEach((m, i) => (machineTotal[m] += rowHours[i]));
  const notProbed = machines.indexOf(NOT_PROBED);
  const machineOrder = machines
    .map((_, m) => m)
    .sort(
      (a, b) =>
        Number(a === notProbed) - Number(b === notProbed) ||
        machineTotal[b] - machineTotal[a]
    );
  const colored = machineOrder
    .filter((m) => m !== notProbed && machineTotal[m] > 0)
    .slice(0, COLORED_MACHINES)
    .sort((a, b) => machines[a].localeCompare(machines[b]));

  const details = new Map(answer.machines.map((m) => [m.machine, m]));
  return {
    owners,
    workflows,
    machines,
    family: machines.map((m) =>
      m === NOT_PROBED ? NOT_PROBED : details.get(m)?.family ?? m
    ),
    short: machines.map((m) =>
      m === NOT_PROBED ? NOT_PROBED : details.get(m)?.short ?? m
    ),
    labels: machines.map((m) =>
      m === NOT_PROBED
        ? answer.unprobed_labels.map((l) => l.label)
        : details.get(m)?.labels ?? []
    ),
    notProbed,
    rowOwner,
    rowWorkflow,
    rowMachine,
    rowHours,
    rowEstimated,
    contributors: answer.contributors,
    total: rowHours.reduce((a, b) => a + b, 0),
    workflowTotal,
    machineTotal,
    machineOrder,
    colored,
  };
}

// What the reader chose, by name, as the URL carries it: the workflow scope
// (empty for every workflow) and the owners and machines highlighted.
export interface CostChoices {
  workflows: readonly string[];
  owners: readonly string[];
  machines: readonly string[];
}

// The choices the answer can serve: names it does not hold, from a stale
// link, are dropped, so a scope of only unknown workflows is every workflow.
export function knownChoices(
  prepared: PreparedHours,
  choices: CostChoices
): CostChoices {
  const known = (names: readonly string[], within: readonly string[]) =>
    Array.from(new Set(names)).filter((name) => within.includes(name));
  return {
    workflows: known(choices.workflows, prepared.workflows),
    owners: known(choices.owners, prepared.owners),
    machines: known(choices.machines, prepared.machines),
  };
}

// The sums every part of the page draws from, for one set of choices.
export interface CostView {
  scope: Set<number>;
  owners: Set<string>;
  machines: Set<number>;
  // The scope's runner-hours, and those of the highlight within it.
  scopeTotal: number;
  highlightTotal: number;
  // Each owner's hours in the scope, by machine, and by machine where the
  // machine is estimated.
  ownerScope: Map<string, number>;
  ownerMachines: Map<string, Float64Array>;
  ownerEstimated: Map<string, Float64Array>;
  // Each machine's hours in the scope, the highlighted owners' share, and
  // the estimated part.
  machineScope: Float64Array;
  machineHighlighted: Float64Array;
  machineEstimated: Float64Array;
  // Each workflow's highlighted hours over the whole window, since the
  // workflows card is read against the window, not the scope.
  workflowHighlighted: Float64Array;
}

export function computeView(
  prepared: PreparedHours,
  choices: CostChoices
): CostView {
  const M = prepared.machines.length;
  const scope = new Set(
    choices.workflows
      .map((w) => prepared.workflows.indexOf(w))
      .filter((w) => w >= 0)
  );
  const owners = new Set(choices.owners);
  const machines = new Set(
    choices.machines
      .map((m) => prepared.machines.indexOf(m))
      .filter((m) => m >= 0)
  );
  const ownerScope = new Map<string, number>();
  const ownerMachines = new Map<string, Float64Array>();
  const ownerEstimated = new Map<string, Float64Array>();
  const machineScope = new Float64Array(M);
  const machineHighlighted = new Float64Array(M);
  const machineEstimated = new Float64Array(M);
  const workflowHighlighted = new Float64Array(prepared.workflows.length);
  let scopeTotal = 0;
  let highlightTotal = 0;
  const highlighting = owners.size > 0 || machines.size > 0;
  for (let i = 0; i < prepared.rowHours.length; i++) {
    const h = prepared.rowHours[i];
    const w = prepared.rowWorkflow[i];
    const m = prepared.rowMachine[i];
    const owner = prepared.owners[prepared.rowOwner[i]];
    const ownerOn = owners.has(owner);
    const inHighlight =
      highlighting &&
      (owners.size === 0 || ownerOn) &&
      (machines.size === 0 || machines.has(m));
    if (inHighlight) workflowHighlighted[w] += h;
    if (scope.size > 0 && !scope.has(w)) continue;
    scopeTotal += h;
    ownerScope.set(owner, (ownerScope.get(owner) ?? 0) + h);
    let mix = ownerMachines.get(owner);
    if (mix === undefined) {
      mix = new Float64Array(M);
      ownerMachines.set(owner, mix);
    }
    mix[m] += h;
    machineScope[m] += h;
    if (prepared.rowEstimated[i]) {
      let estimated = ownerEstimated.get(owner);
      if (estimated === undefined) {
        estimated = new Float64Array(M);
        ownerEstimated.set(owner, estimated);
      }
      estimated[m] += h;
      machineEstimated[m] += h;
    }
    if (ownerOn) machineHighlighted[m] += h;
    if (inHighlight) highlightTotal += h;
  }
  return {
    scope,
    owners,
    machines,
    scopeTotal,
    highlightTotal,
    ownerScope,
    ownerMachines,
    ownerEstimated,
    machineScope,
    machineHighlighted,
    machineEstimated,
    workflowHighlighted,
  };
}

// Some names joined for a sentence: "pull + trunk", or the first two and how
// many more.
export function joinNames(names: readonly string[]): string {
  return names.length <= 3
    ? names.join(" + ")
    : `${names.slice(0, 2).join(" + ")} + ${names.length - 2} more`;
}

// The scope in words, its workflows largest first: "all workflows", "pull +
// trunk".
export function scopeName(prepared: PreparedHours, view: CostView): string {
  if (view.scope.size === 0) return "all workflows";
  return joinNames(
    Array.from(view.scope)
      .sort((a, b) => a - b)
      .map((w) => prepared.workflows[w])
  );
}

// The highlight in words: "inductor on NVIDIA L4", "on 2 machines".
export function highlightName(prepared: PreparedHours, view: CostView): string {
  const owners = Array.from(view.owners).map(ownerLabel);
  const machines = prepared.machineOrder
    .filter((m) => view.machines.has(m))
    .map((m) => prepared.machines[m]);
  return [
    owners.length > 0 ? joinNames(owners) : "",
    machines.length > 0 ? `on ${joinNames(machines)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// Whether the scope is exactly a preset's workflows.
export function isScope(
  scope: readonly string[],
  workflows: readonly string[]
): boolean {
  const set = new Set(scope);
  return set.size === workflows.length && workflows.every((w) => set.has(w));
}

// The page's headline figures, all of the scope.
export function factsOf(prepared: PreparedHours, view: CostView, days: number) {
  let attributed = 0;
  for (const [owner, h] of view.ownerScope)
    if (!isBucket(owner)) attributed += h;
  return {
    scopeTotal: view.scopeTotal,
    scopeShare: prepared.total > 0 ? view.scopeTotal / prepared.total : 0,
    perDay: view.scopeTotal / days,
    annualized: (view.scopeTotal / days) * 365,
    attributedShare: view.scopeTotal > 0 ? attributed / view.scopeTotal : 0,
  };
}

// One row of the owner chart or the matrix: an owner, the owners past the
// top folded together, or a bucket of the hours no owner is given.
export interface OwnerRow {
  key: string;
  label: string;
  owners: string[];
  hours: number;
  kind: "owner" | "more" | "less" | "bucket";
}

// The scope's owners largest first, the top ones named and every
// highlighted one in its own row wherever it ranks, the rest folded into
// "N more owners" (listed while expanded), then the buckets: two rows in
// the chart, shared and unattributed, or one per bucket in the matrix.
export function ownerRows(
  view: CostView,
  expanded: boolean,
  buckets: "grouped" | "each",
  top: number = TOP_OWNERS
): OwnerRow[] {
  const owners = Array.from(view.ownerScope)
    .filter(([owner, h]) => !isBucket(owner) && h > 0)
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
  const bucketRow = (
    key: string,
    label: string,
    keys: string[]
  ): OwnerRow[] => {
    const present = keys.filter((k) => (view.ownerScope.get(k) ?? 0) > 0);
    const hours = present.reduce(
      (a, k) => a + (view.ownerScope.get(k) ?? 0),
      0
    );
    return hours > 0
      ? [{ key, label, owners: present, hours, kind: "bucket" }]
      : [];
  };
  if (buckets === "grouped") {
    rows.push(
      ...bucketRow(
        "shared",
        SHARED_ROW,
        BUCKET_ORDER.filter((b) => b.startsWith("shared:"))
      ),
      ...bucketRow(
        "unattributed",
        UNATTRIBUTED_ROW,
        BUCKET_ORDER.filter((b) => b.startsWith("unattributed:"))
      )
    );
  } else {
    for (const b of BUCKET_ORDER)
      rows.push(...bucketRow(b, BUCKET_LABELS[b], [b]));
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
export type Paint = BasePaint | { kind: "estimated"; of: BasePaint };

export interface Segment {
  key: string;
  label: string;
  hours: number;
  paint: Paint;
}

// A machine's paint: its hue among the colored, else Not probed's hatch,
// else the accent while highlighted and the other machines' grey otherwise,
// so a highlighted machine never reads as one of the others.
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
  paint: BasePaint
): Segment[] {
  const out: Segment[] = [];
  if (hours - estimated > 1e-9) {
    out.push({ key, label, hours: hours - estimated, paint });
  }
  if (estimated > 1e-9) {
    out.push({
      key: `${key} (estimated)`,
      label: `${label}, estimated from runner labels`,
      hours: estimated,
      paint: { kind: "estimated", of: paint },
    });
  }
  return out;
}

// A bar's pieces in the machines' fixed order: the colored machines, then
// the others together, then Unknown machine, each split into reported and
// estimated hours (estimated, the same row's hours whose machine came from a
// runner label). With machines highlighted, those machines' pieces come
// first, each in its paint (an uncolored machine in the accent), and the rest
// of the bar is one pale piece, so the highlighted hours line up at the start
// of every bar.
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
      paintOf(prepared, m, highlighted.has(m))
    );
  if (highlighted.size > 0) {
    const on = order
      .filter((m) => highlighted.has(m) && mix[m] > 0)
      .flatMap(piece);
    const rest = order
      .filter((m) => !highlighted.has(m))
      .reduce((a, m) => a + mix[m], 0);
    return rest > 0
      ? [
          ...on,
          {
            key: "rest",
            label: "other machines",
            hours: rest,
            paint: { kind: "pale" },
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
        { kind: "other" }
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
// together (with their members listed beneath while open), or Not probed.
export interface KeyRow {
  key: string;
  label: string;
  machines: number[];
  hours: number;
  // The hours on these machines whose machine is estimated.
  estimated: number;
  // The highlighted owners' hours on these machines.
  highlighted: number;
  paint: BasePaint;
  kind: "machine" | "group" | "member";
}

export function machineKeyRows(
  prepared: PreparedHours,
  view: CostView,
  open: boolean
): KeyRow[] {
  const s = view.machineScope;
  const row = (m: number, kind: KeyRow["kind"]): KeyRow => ({
    key: prepared.machines[m],
    label: prepared.machines[m],
    machines: [m],
    hours: s[m],
    estimated: view.machineEstimated[m],
    highlighted: view.machineHighlighted[m],
    paint: paintOf(prepared, m, view.machines.has(m)),
    kind,
  });
  const rows = prepared.machineOrder
    .filter((m) => prepared.colored.includes(m) && s[m] > 0)
    .map((m) => row(m, "machine"));
  const others = prepared.machineOrder.filter(
    (m) => m !== prepared.notProbed && !prepared.colored.includes(m) && s[m] > 0
  );
  if (others.length > 0) {
    rows.push({
      key: OTHER_MACHINES,
      label: `${OTHER_MACHINES} (${others.length})`,
      machines: others,
      hours: others.reduce((a, m) => a + s[m], 0),
      estimated: others.reduce((a, m) => a + view.machineEstimated[m], 0),
      highlighted: others.reduce((a, m) => a + view.machineHighlighted[m], 0),
      paint: { kind: "other" },
      kind: "group",
    });
    if (open) rows.push(...others.map((m) => row(m, "member")));
  }
  if (prepared.notProbed >= 0 && s[prepared.notProbed] > 0) {
    rows.push(row(prepared.notProbed, "machine"));
  }
  return rows;
}

// The workflows the card lists, largest first: the top few and every
// scoped one, or while expanded all of them, narrowed by the search (scoped
// ones always stay).
export function workflowRows(
  prepared: PreparedHours,
  view: CostView,
  expanded: boolean,
  search: string,
  top: number = TOP_WORKFLOWS
): { shown: number[]; hidden: number } {
  const all = prepared.workflows
    .map((_, w) => w)
    .filter((w) => prepared.workflowTotal[w] > 0);
  const q = search.trim().toLowerCase();
  const shown = expanded
    ? all.filter(
        (w) =>
          view.scope.has(w) || q === "" || prepared.workflows[w].includes(q)
      )
    : all.filter((w, i) => i < top || view.scope.has(w));
  return { shown, hidden: all.length - shown.length };
}

// The matrix's columns: the scope's machines with hours, grouped by family,
// the largest family first and Not probed last, the largest machine first
// within each.
export interface MatrixGroup {
  family: string;
  machines: number[];
}

export function matrixGroups(
  prepared: PreparedHours,
  view: CostView
): MatrixGroup[] {
  const live = prepared.machines
    .map((_, m) => m)
    .filter((m) => view.machineScope[m] >= MIN_CELL_HOURS);
  const familyTotal = new Map<string, number>();
  for (const m of live) {
    const f = prepared.family[m];
    familyTotal.set(f, (familyTotal.get(f) ?? 0) + view.machineScope[m]);
  }
  return Array.from(familyTotal)
    .sort(
      (a, b) =>
        Number(a[0] === NOT_PROBED) - Number(b[0] === NOT_PROBED) || b[1] - a[1]
    )
    .map(([family]) => ({
      family,
      machines: live
        .filter((m) => prepared.family[m] === family)
        .sort((a, b) => view.machineScope[b] - view.machineScope[a]),
    }));
}

// What a cell shows, from 0 to 1 for its shade: an owner's share of the
// machine, the machine's share of the owner, or the hours on a square-root
// scale against the largest cell.
export type CellMode = "machine" | "owner" | "hours";

export function cellShade(
  mode: CellMode,
  hours: number,
  rowTotal: number,
  columnTotal: number,
  maxCell: number
): number {
  if (mode === "hours") return maxCell > 0 ? Math.sqrt(hours / maxCell) : 0;
  const base = mode === "machine" ? columnTotal : rowTotal;
  return base > 0 ? Math.min(1, hours / base) : 0;
}

// One cell's hours by workflow, and by owner for a folded row, in the scope;
// the part whose machine is estimated; and for an unattributed bucket, what
// it is made of: runner labels or test files, largest first.
export function cellDetail(
  prepared: PreparedHours,
  view: CostView,
  owners: readonly string[],
  machine: number
) {
  const wanted = new Set(owners);
  const byWorkflow = new Map<string, number>();
  const byOwner = new Map<string, number>();
  let hours = 0;
  let estimated = 0;
  const contributors = new Map<
    string,
    { kind: Contributor["kind"]; hours: number }
  >();
  const machineName = machine === prepared.notProbed ? "" : prepared.machines[machine];
  for (const c of prepared.contributors) {
    if (!wanted.has(c.bucket) || c.machine !== machineName) continue;
    const w = prepared.workflows.indexOf(c.workflow);
    if (view.scope.size > 0 && !view.scope.has(w)) continue;
    const entry = contributors.get(c.key);
    if (entry === undefined) {
      contributors.set(c.key, { kind: c.kind, hours: c.runner_hours });
    } else {
      entry.hours += c.runner_hours;
    }
  }
  for (let i = 0; i < prepared.rowHours.length; i++) {
    if (prepared.rowMachine[i] !== machine) continue;
    const w = prepared.rowWorkflow[i];
    if (view.scope.size > 0 && !view.scope.has(w)) continue;
    const owner = prepared.owners[prepared.rowOwner[i]];
    if (!wanted.has(owner)) continue;
    const h = prepared.rowHours[i];
    hours += h;
    if (prepared.rowEstimated[i]) estimated += h;
    byWorkflow.set(
      prepared.workflows[w],
      (byWorkflow.get(prepared.workflows[w]) ?? 0) + h
    );
    byOwner.set(owner, (byOwner.get(owner) ?? 0) + h);
  }
  const sorted = (m: Map<string, number>) =>
    Array.from(m).sort((a, b) => b[1] - a[1]);
  return {
    hours,
    estimated,
    byWorkflow: sorted(byWorkflow),
    byOwner: sorted(byOwner),
    contributors: Array.from(contributors, ([key, c]) => ({ key, ...c })).sort(
      (a, b) => b.hours - a.hours
    ),
  };
}

// The rows in the scope and the highlight, as CSV.
export function rowsCsv(
  prepared: PreparedHours,
  view: CostView
): { csv: string; rows: number } {
  const lines = ["owner,workflow,machine,machine_estimated,runner_hours"];
  for (let i = 0; i < prepared.rowHours.length; i++) {
    const w = prepared.rowWorkflow[i];
    const m = prepared.rowMachine[i];
    const owner = prepared.owners[prepared.rowOwner[i]];
    if (view.scope.size > 0 && !view.scope.has(w)) continue;
    if (view.machines.size > 0 && !view.machines.has(m)) continue;
    if (view.owners.size > 0 && !view.owners.has(owner)) continue;
    lines.push(
      [
        owner,
        prepared.workflows[w],
        prepared.machines[m],
        prepared.rowEstimated[i] ? "yes" : "no",
        prepared.rowHours[i].toFixed(2),
      ]
        .map(escapeCSV)
        .join(",")
    );
  }
  return { csv: `${lines.join("\n")}\n`, rows: lines.length - 1 };
}

// Toggles names in a selection: all of them out if every one is in,
// otherwise all of them in.
export function toggled(
  selection: readonly string[],
  names: readonly string[]
): string[] {
  const all = names.length > 0 && names.every((n) => selection.includes(n));
  return all
    ? selection.filter((n) => !names.includes(n))
    : [...selection, ...names.filter((n) => !selection.includes(n))];
}
