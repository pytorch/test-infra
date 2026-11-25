import type { Contributor, RunnerHours } from "lib/api/tests/cost/types";

// The cost page's sums over GET /api/tests/cost, done in the browser:
// the answer holds every owner, workflow and machine of the window, so a
// change of scope or highlight is a pass over a few thousand rows, not a
// request. Pure functions of the answer and the reader's choices; the
// components only draw what these return.
//
// Three rules hold throughout. Within an answer, the workflow scope is the
// only choice that changes the numbers: owners and machines highlight, and
// nothing re-sorts or rescales when they do. Machines keep one order, the
// window's largest first and Unknown machine last. The seven largest
// machines over the window keep their hues whatever is scoped.

// The machine of runner-hours on runner labels that no job with test
// reports ran on, which the API names "".
export const NOT_PROBED = "Unknown machine";

// How many workflows the workflows card lists before "+ N more".
export const TOP_WORKFLOWS = 4;
// How many machines keep a hue of their own.
export const COLORED_MACHINES = 7;

export const BUCKET_LABELS: Record<string, string> = {
  // No owner first: its rows look like any owner's, then the striped rows
  // of test jobs without reports.
  "unattributed:no_owner": "No owner",
  "unattributed:no_test_reports": "No test reports",
};

export function isBucket(owner: string): boolean {
  return owner.startsWith("unattributed:");
}

export function ownerLabel(owner: string): string {
  return BUCKET_LABELS[owner] ?? owner;
}

// What an amount counts: runner-hours, or $ from a rates file.
export type CostUnit = "hours" | "cost";

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
  // Each row's runner-hours.
  rowHours: Float64Array;
  // 1 where the row's machine is estimated from its runner label.
  rowEstimated: Uint8Array;
  // What the unattributed buckets are made of, with each one's workflow
  // and machine index (-1 where no row has it).
  contributors: Contributor[];
  contributorWorkflow: Int32Array;
  contributorMachine: Int32Array;
  total: number;
  workflowTotal: Float64Array;
  machineTotal: Float64Array;
  // The window's largest machine first, Not probed last.
  machineOrder: number[];
  // The machines with a hue, in name order, so a change of rank among them
  // does not repaint them; the hue is the theme's for that position.
  colored: number[];
}

// Any answer of GET /api/tests/cost's rows: the window's, or /owners' over B,
// which has no contributors.
export function prepareRunnerHours(
  answer: Pick<RunnerHours, "rows" | "machines" | "unprobed_labels"> &
    Partial<Pick<RunnerHours, "contributors">>
): PreparedHours {
  const contributors = answer.contributors ?? [];
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
  const workflowOf = new Map(workflows.map((w, i) => [w, i]));
  const machineOf = new Map(machines.map((m, i) => [m, i]));
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
    contributors,
    contributorWorkflow: Int32Array.from(
      contributors,
      (c) => workflowOf.get(c.workflow) ?? -1
    ),
    contributorMachine: Int32Array.from(
      contributors,
      (c) => machineOf.get(c.machine === "" ? NOT_PROBED : c.machine) ?? -1
    ),
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
  // Each machine's hours in the scope, and the highlighted owners' share.
  machineScope: Float64Array;
  machineHighlighted: Float64Array;
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
