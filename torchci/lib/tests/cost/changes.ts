import type { CostChanges } from "lib/api/tests/cost/types";
import { averageRate, rateOf, type RatesFile } from "lib/tests/cost/rates";
import {
  NOT_PROBED,
  OTHER_MACHINES,
  type PreparedHours,
} from "lib/tests/cost/runnerHours";
import {
  addHours,
  type TrendPer,
  type TrendTotals,
  zeroTotals,
} from "lib/tests/cost/trend";

// What changed between the trend's two periods, A and B: GET
// /api/tests/cost/changes's runner-hours by machine and runner label,
// summed in the browser per day with data or per commit (push:main
// runner-hours over pushes to main), with a rates file in $. Pure functions
// of the answer, as trend.ts's are; TrendChanges and ChangesMachines only
// draw them.

const inRange = (day: string, r: { from: string; to: string }) =>
  day >= r.from && day <= r.to;

// Each side's days with data and its pushes to main on them.
export function changeDays(changes: CostChanges): {
  aDays: number;
  bDays: number;
  aPushes: number;
  bPushes: number;
} {
  let aDays = 0;
  let bDays = 0;
  let aPushes = 0;
  let bPushes = 0;
  for (const [day, pushes] of changes.days) {
    if (inRange(day, changes.a)) {
      aDays++;
      aPushes += pushes;
    }
    if (inRange(day, changes.b)) {
      bDays++;
      bPushes += pushes;
    }
  }
  return { aDays, bDays, aPushes, bPushes };
}

// What each side's sums are divided by: its days with data, or its pushes.
function denominators(changes: CostChanges, per: TrendPer): [number, number] {
  const d = changeDays(changes);
  return per === "day" ? [d.aDays, d.bDays] : [d.aPushes, d.bPushes];
}

function factors(
  changes: CostChanges,
  rates: RatesFile | null
): (number | null)[] {
  return changes.labels.map((l) => (rates === null ? 1 : rateOf(rates, l)));
}

// Each side's sums by runner label (all runner-hours, or per commit those
// of pushes to main) or by trigger (push:main, then the rest per day).
function sums(
  changes: CostChanges,
  by: "label" | "trigger",
  rates: RatesFile | null,
  per: TrendPer
): { names: string[]; a: TrendTotals[]; b: TrendTotals[] } {
  const f = factors(changes, rates);
  const names = by === "label" ? changes.labels : ["push:main", "other"];
  const a = names.map(zeroTotals);
  const b = names.map(zeroTotals);
  for (const [side, label, hours, main] of changes.cells) {
    const into = side === 0 ? a : b;
    if (by === "trigger") {
      addHours(into[0], main, f[label]);
      if (per === "day") addHours(into[1], hours - main, f[label]);
      continue;
    }
    addHours(into[label], per === "day" ? hours : main, f[label]);
  }
  return { names, a, b };
}

// One row: a runner label's, a machine's or a group's value per day with
// data (or per commit) in A and in B. Change is B's against A's, null where
// A had none.
export interface ChangeRow {
  key: string;
  name: string;
  a: TrendTotals;
  b: TrendTotals;
  aPer: number;
  bPer: number;
  delta: number;
  change: number | null;
}

function changeRow(
  key: string,
  name: string,
  a: TrendTotals,
  b: TrendTotals,
  aDen: number,
  bDen: number
): ChangeRow {
  const aPer = aDen > 0 ? a.value / aDen : 0;
  const bPer = bDen > 0 ? b.value / bDen : 0;
  return perRow(key, name, a, b, aPer, bPer);
}

function perRow(
  key: string,
  name: string,
  a: TrendTotals,
  b: TrendTotals,
  aPer: number,
  bPer: number
): ChangeRow {
  const delta = bPer - aPer;
  return {
    key,
    name,
    a,
    b,
    aPer,
    bPer,
    delta,
    change: aPer > 0 ? delta / aPer : null,
  };
}

function sumTotals(ts: TrendTotals[]): TrendTotals {
  return ts.reduce((t, x) => {
    t.value += x.value;
    t.runnerHours += x.runnerHours;
    t.unpriced += x.unpriced;
    return t;
  }, zeroTotals());
}

// Rows of the same answer and per as one: the other machines together, or
// every machine.
export function foldChanges(
  key: string,
  name: string,
  rows: ChangeRow[]
): ChangeRow {
  return perRow(
    key,
    name,
    sumTotals(rows.map((r) => r.a)),
    sumTotals(rows.map((r) => r.b)),
    rows.reduce((t, r) => t + r.aPer, 0),
    rows.reduce((t, r) => t + r.bPer, 0)
  );
}

// The whole change, per day or per commit, and in $ what made it: the
// priced runner-hours gained or lost at A's average $ per runner-hour
// (volume), and B's hours at B's average less A's (mix: pricier or cheaper
// machines); the two sum to the change. With pushes to main, each period's
// pushes per day and push:main value per push, whichever the change is by.
export interface ChangeSummary {
  aDays: number;
  bDays: number;
  a: TrendTotals;
  b: TrendTotals;
  aPer: number;
  bPer: number;
  delta: number;
  change: number | null;
  volume: number | null;
  mix: number | null;
  push: {
    aPushesPerDay: number;
    bPushesPerDay: number;
    aPerPush: number | null;
    bPerPush: number | null;
    change: number | null;
  } | null;
}

export function changeSummary(
  changes: CostChanges,
  rates: RatesFile | null,
  per: TrendPer = "day"
): ChangeSummary {
  const { aDays, bDays, aPushes, bPushes } = changeDays(changes);
  const [aDen, bDen] = per === "day" ? [aDays, bDays] : [aPushes, bPushes];
  const all = sums(changes, "trigger", rates, per);
  const row = changeRow(
    "all",
    "all",
    sumTotals(all.a),
    sumTotals(all.b),
    aDen,
    bDen
  );
  let volume: number | null = null;
  let mix: number | null = null;
  if (rates !== null && aDen > 0 && bDen > 0) {
    const pricedA = (row.a.runnerHours - row.a.unpriced) / aDen;
    const pricedB = (row.b.runnerHours - row.b.unpriced) / bDen;
    const rateA = averageRate(row.a.value, row.a.runnerHours, row.a.unpriced);
    const rateB = averageRate(row.b.value, row.b.runnerHours, row.b.unpriced);
    if (rateA !== null && rateB !== null) {
      volume = (pricedB - pricedA) * rateA;
      mix = pricedB * (rateB - rateA);
    }
  }
  let push: ChangeSummary["push"] = null;
  if (aDays > 0 && bDays > 0 && (aPushes > 0 || bPushes > 0)) {
    const main = sums(changes, "trigger", rates, "commit");
    const aPerPush = aPushes > 0 ? main.a[0].value / aPushes : null;
    const bPerPush = bPushes > 0 ? main.b[0].value / bPushes : null;
    push = {
      aPushesPerDay: aPushes / aDays,
      bPushesPerDay: bPushes / bDays,
      aPerPush,
      bPerPush,
      change:
        aPerPush !== null && bPerPush !== null && aPerPush > 0
          ? (bPerPush - aPerPush) / aPerPush
          : null,
    };
  }
  return {
    aDays,
    bDays,
    a: row.a,
    b: row.b,
    aPer: row.aPer,
    bPer: row.bPer,
    delta: row.delta,
    change: row.change,
    volume,
    mix,
    push,
  };
}

// Each runner label's machine as the cost answer names it: the machine its
// rows there spent the most runner-hours on. A label the answer does not
// hold (it ran in the periods but not the cost page's window) has none.
export function labelMachines(prepared: PreparedHours): Map<string, string> {
  const hours = new Map<string, Map<string, number>>();
  for (let i = 0; i < prepared.rowLabel.length; i++) {
    const label = prepared.runnerLabels[prepared.rowLabel[i]];
    const machine = prepared.machines[prepared.rowMachine[i]];
    const byMachine = hours.get(label) ?? new Map<string, number>();
    byMachine.set(
      machine,
      (byMachine.get(machine) ?? 0) + prepared.rowRunnerHours[i]
    );
    hours.set(label, byMachine);
  }
  return new Map(
    Array.from(hours, ([label, byMachine]) => [
      label,
      Array.from(byMachine).sort((x, y) => y[1] - x[1])[0][0],
    ])
  );
}

// A machine's change with its runners': the labels it runs, each a row.
export interface MachineChange {
  machine: string;
  row: ChangeRow;
  runners: ChangeRow[];
}

// The change by machine, largest in B first, Unknown machine (labels no
// machine is known for) last, each machine's runners largest in B first.
export function machineChanges(
  changes: CostChanges,
  rates: RatesFile | null,
  per: TrendPer,
  machineOf: ReadonlyMap<string, string>
): MachineChange[] {
  const [aDen, bDen] = denominators(changes, per);
  const { names, a, b } = sums(changes, "label", rates, per);
  const byMachine = new Map<string, number[]>();
  names.forEach((label, i) => {
    if (a[i].runnerHours === 0 && b[i].runnerHours === 0) return;
    const machine = machineOf.get(label) ?? NOT_PROBED;
    byMachine.set(machine, [...(byMachine.get(machine) ?? []), i]);
  });
  const machines = Array.from(byMachine, ([machine, labels]) => {
    const runners = labels
      .map((i) => changeRow(names[i], names[i], a[i], b[i], aDen, bDen))
      .sort((x, y) => y.bPer - x.bPer || x.name.localeCompare(y.name));
    return {
      machine,
      runners,
      row: changeRow(
        machine,
        machine,
        sumTotals(runners.map((r) => r.a)),
        sumTotals(runners.map((r) => r.b)),
        aDen,
        bDen
      ),
    };
  });
  return machines.sort(
    (x, y) =>
      Number(x.machine === NOT_PROBED) - Number(y.machine === NOT_PROBED) ||
      y.row.bPer - x.row.bPer ||
      x.machine.localeCompare(y.machine)
  );
}

// How many rows the machine table shows under every machine before "N more
// machines": the largest few, so what changed stays short.
export const TOP_MACHINE_ROWS = 5;

// One row of the machine table: every machine, a colored machine (or
// Unknown machine), the other machines together, the rows past the top
// folded, or while they are listed, the row that folds them back (its
// figures 0). Machines are those it stands for: its own, the group's, or
// the folded rows'.
export interface MachineLine {
  key: string;
  label: string;
  kind: "all" | "machine" | "group" | "more" | "less";
  row: ChangeRow;
  machines: MachineChange[];
}

// The machine table's rows, laid out as the page's machine keys are: every
// machine first, then a row per colored machine, the other machines
// together and Unknown machine last; past the top rows, the rest fold into
// "N more machines" (never just one row), each folded machine counted once
// and the other machines each, and while they are listed a last row folds
// them back. The rows under every machine sum to it, folded or not.
export function machineLines(
  machines: MachineChange[],
  colored: (_machine: string) => boolean,
  expanded: boolean,
  top: number = TOP_MACHINE_ROWS
): MachineLine[] {
  const line = (
    key: string,
    label: string,
    kind: MachineLine["kind"],
    of: MachineChange[]
  ): MachineLine => ({
    key,
    label,
    kind,
    row: foldChanges(
      key,
      label,
      of.map((m) => m.row)
    ),
    machines: of,
  });
  const lines = machines
    .filter((m) => colored(m.machine) && m.machine !== NOT_PROBED)
    .map((m) => line(m.machine, m.machine, "machine", [m]));
  const others = machines.filter(
    (m) => !colored(m.machine) && m.machine !== NOT_PROBED
  );
  if (others.length > 0) {
    lines.push(
      line(
        OTHER_MACHINES,
        `${OTHER_MACHINES} (${others.length})`,
        "group",
        others
      )
    );
  }
  const unknown = machines.find((m) => m.machine === NOT_PROBED);
  if (unknown !== undefined) {
    lines.push(line(NOT_PROBED, NOT_PROBED, "machine", [unknown]));
  }
  const all = line("all", "All machines", "all", machines);
  const hidden = lines.slice(top);
  if (hidden.length < 2) return [all, ...lines];
  if (expanded) return [all, ...lines, line("less", "Show fewer", "less", [])];
  const folded = hidden.flatMap((l) => l.machines);
  return [
    all,
    ...lines.slice(0, top),
    line("more", `${folded.length} more machines`, "more", folded),
  ];
}

// A change as the table writes it: "▲ +23%", "▼ −26%", "new" where A had
// none, "gone" where B has none, "—" where neither moved.
export function changeWord(
  row: Pick<ChangeRow, "change" | "delta" | "bPer">
): string {
  if (row.delta === 0) return "—";
  if (row.change === null) return "new";
  if (row.bPer === 0) return "gone";
  const pct = Math.abs(row.change * 100);
  const up = row.change > 0;
  if (pct < 1) return up ? "▲ <1%" : "▼ <1%";
  return up ? `▲ +${pct.toFixed(0)}%` : `▼ −${pct.toFixed(0)}%`;
}
