import {
  COST_DAYS,
  COST_WINDOW_END,
  type CostParams,
  SIGNALS,
  WORKFLOW_PRESETS,
} from "lib/api/tests/cost/parameters";
import {
  machinesQuery,
  runnerHoursQuery,
  timeToSignalQuery,
} from "lib/api/tests/cost/query";
import type {
  CostMachine,
  CostSignal,
  RunnerHours,
} from "lib/api/tests/cost/types";
import { CI_WORKLOAD_HEAVY } from "lib/api/tests/database";
import { queryClickhouse } from "lib/clickhouse";

const DAY_MS = 24 * 60 * 60 * 1000;

const METHOD =
  "Each test job's wall time split among its test files by occupancy (the runner time each file's reports held, setup and idle time shared alike), then evenly among each file's owners (test_cost). Builds and other jobs are shared; test jobs without test reports and files without owners are unattributed. Machines come from each job's test reports, or for jobs without them, from their runner label's reporting jobs.";

interface RunnerHoursQueryRow {
  owner: string;
  workflow: string;
  machine: string;
  label: string;
  runner_hours: number;
}

interface MachineRow {
  machine: string;
  family: string;
  device: string;
  cpu: string;
}

interface SignalRow {
  workflow: string;
  runs: number;
  seconds: number[];
}

// The last whole UTC days ending at the start of today, as the queries'
// parameters spell them.
export function windowBounds(days: number, now: Date) {
  const endMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const startMs = endMs - days * DAY_MS;
  const spell = (ms: number) =>
    new Date(ms).toISOString().replace("T", " ").slice(0, 23);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    params: { start: spell(startMs), end: spell(endMs) },
  };
}

function sortedByHours(hours: Map<string, number>): string[] {
  return Array.from(hours)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
}

// The answer's rows, runner labels folded away: one row per owner,
// workflow and machine, largest first.
export function runnerHoursRows(
  rows: RunnerHoursQueryRow[]
): RunnerHours["rows"] {
  const cells = new Map<string, RunnerHours["rows"][number]>();
  for (const row of rows) {
    const hours = Number(row.runner_hours);
    if (!(hours > 0)) continue;
    const key = JSON.stringify([row.owner, row.workflow, row.machine]);
    const cell = cells.get(key);
    if (cell === undefined) {
      cells.set(key, {
        owner: row.owner,
        workflow: row.workflow,
        machine: row.machine,
        runner_hours: hours,
      });
    } else {
      cell.runner_hours += hours;
    }
  }
  return Array.from(cells.values()).sort(
    (a, b) => b.runner_hours - a.runner_hours
  );
}

// The runner labels of the hours whose machine is unknown, largest first.
export function unprobedLabels(
  rows: RunnerHoursQueryRow[]
): RunnerHours["unprobed_labels"] {
  const byLabel = new Map<string, number>();
  for (const row of rows) {
    if (row.machine !== "") continue;
    byLabel.set(
      row.label,
      (byLabel.get(row.label) ?? 0) + Number(row.runner_hours)
    );
  }
  return Array.from(byLabel, ([label, runner_hours]) => ({
    label,
    runner_hours,
  })).sort((a, b) => b.runner_hours - a.runner_hours);
}

// Device names shortened against each other, with no list of vendors: a
// device drops its leading words while another device of its family starts
// with the same words and goes on past them, and keeps at least one. With NVIDIA L4 and NVIDIA
// A10G present, they read L4 and A10G; Tesla T4, alone in its first word,
// stays whole; AMD Instinct MI350X VF beside AMD Instinct MI300X reads MI350X
// VF. A new vendor's devices shorten as soon as two of them run.
export function shortDeviceNames(
  devices: readonly string[]
): Map<string, string> {
  const words = new Map(devices.map((d) => [d, d.split(" ")]));
  const short = new Map<string, string>();
  for (const [device, parts] of words) {
    let drop = 0;
    while (drop < parts.length - 1) {
      const prefix = parts.slice(0, drop + 1).join(" ");
      // Another device continues past the same words: Apple M2 does not
      // make Apple M2 Pro read Pro.
      const shared = devices.some((other) => {
        const theirs = words.get(other) ?? [];
        return (
          other !== device &&
          theirs.length > drop + 1 &&
          theirs.slice(0, drop + 1).join(" ") === prefix
        );
      });
      if (!shared) break;
      drop += 1;
    }
    short.set(device, parts.slice(drop).join(" "));
  }
  return short;
}

// Every machine with runner-hours, largest first, with its family, short
// name and the runner labels mapped to it.
export function costMachines(
  rows: RunnerHoursQueryRow[],
  details: MachineRow[]
): CostMachine[] {
  const hours = new Map<string, number>();
  const labels = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (row.machine === "") continue;
    const h = Number(row.runner_hours);
    hours.set(row.machine, (hours.get(row.machine) ?? 0) + h);
    let byLabel = labels.get(row.machine);
    if (byLabel === undefined) {
      byLabel = new Map();
      labels.set(row.machine, byLabel);
    }
    byLabel.set(row.label, (byLabel.get(row.label) ?? 0) + h);
  }
  const detailOf = new Map(details.map((d) => [d.machine, d]));
  const present = sortedByHours(hours);
  // Devices are shortened against the others of their family that ran.
  const devicesByFamily = new Map<string, string[]>();
  for (const machine of present) {
    const detail = detailOf.get(machine);
    if (detail === undefined || detail.device === "") continue;
    const family = devicesByFamily.get(detail.family) ?? [];
    family.push(detail.device);
    devicesByFamily.set(detail.family, family);
  }
  const shortOf = new Map<string, string>();
  for (const devices of devicesByFamily.values()) {
    for (const [device, short] of shortDeviceNames(devices)) {
      shortOf.set(device, short);
    }
  }
  return present.map((machine) => {
    const detail = detailOf.get(machine);
    return {
      machine,
      // A machine is named from ci.environments, so it has details; should
      // one not, it is its own family.
      family: detail?.family || machine,
      short:
        detail === undefined
          ? machine
          : detail.device !== ""
          ? shortOf.get(detail.device) ?? detail.device
          : detail.cpu || machine,
      labels: sortedByHours(labels.get(machine) ?? new Map()),
    };
  });
}

// Each signal's time from its workflow's runs, in SIGNALS' order; a signal
// whose workflow had no runs in the window has no time.
export function costSignals(rows: SignalRow[]): CostSignal[] {
  return SIGNALS.map((signal) => {
    const row = rows.find((r) => r.workflow === signal.workflow);
    return {
      ...signal,
      runs: Number(row?.runs ?? 0),
      p50_seconds: row === undefined ? null : Number(row.seconds[0]),
      p90_seconds: row === undefined ? null : Number(row.seconds[1]),
    };
  });
}

export async function getRunnerHours(
  params: CostParams,
  now: Date = COST_WINDOW_END
): Promise<RunnerHours> {
  const bounds = windowBounds(COST_DAYS, now);
  const queryParams = { repo: params.repo, ...bounds.params };
  const started = performance.now();
  // The runner-hours, the machines' names and HUD's time to signal, asked at once.
  // The runner-hours query reads the window's rows of test_cost and its build
  // and other jobs; it stays in the heavy workload
  // (app/api/README.md, Heavy queries) until measured; the other two are cheap.
  const [rows, machineRows, signalRows]: [
    RunnerHoursQueryRow[],
    MachineRow[],
    SignalRow[]
  ] = await Promise.all([
    queryClickhouse(
      runnerHoursQuery(),
      queryParams,
      "tests_cost_runner_hours",
      false,
      CI_WORKLOAD_HEAVY
    ),
    queryClickhouse(machinesQuery(), {}, "tests_cost_machines"),
    queryClickhouse(
      timeToSignalQuery(),
      { ...queryParams, tts_workflows: SIGNALS.map((s) => s.workflow) },
      "tests_cost_time_to_signal"
    ),
  ]);
  return {
    repo: params.repo,
    days: COST_DAYS,
    start: bounds.start,
    end: bounds.end,
    rows: runnerHoursRows(rows),
    machines: costMachines(rows, machineRows),
    unprobed_labels: unprobedLabels(rows),
    time_to_signal: costSignals(signalRows),
    workflow_presets: WORKFLOW_PRESETS.map((p) => ({
      ...p,
      workflows: [...p.workflows],
    })),
    method: METHOD,
    query_duration_ms: Math.round(performance.now() - started),
  };
}
