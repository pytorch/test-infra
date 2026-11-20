import { queryClickhouse } from "lib/api/tests/clickhouse";
import type {
  CostScope,
  Day,
  DayRange,
  Pill,
  ScopeBy,
  ScopeChildInfo,
  ScopePiece,
  ScopeSide,
} from "lib/api/tests/cost/contracts";
import { addDays, UNKNOWN_MACHINE } from "lib/api/tests/cost/contracts";
import type { CostScopeParams } from "lib/api/tests/cost/parameters";
import { parseDayRange } from "lib/api/tests/cost/parameters";
import {
  ENV_MACHINES,
  FILLING_HOURS,
  IN_SCOPE,
  IN_SIDES,
  latestDayRows,
  machinesQuery,
  MAIN_MS,
  MAIN_PUSHES,
  SIDES,
  TEST_COST,
  weekLabelMachines,
  WORKFLOW,
} from "lib/api/tests/cost/query";
import { costMachines } from "lib/api/tests/cost/runnerHours";
import { CI_DATABASE } from "lib/api/tests/database";
import { toEnvironment, type EnvironmentRow } from "lib/api/tests/mapping";

// Where a scope query's rows come from: the days of two compared sides, A and
// B (parameters a_from..b_to), or every day of one range (from, to).
export type ScopeGrain = "sides" | "days";

const DAYS: Record<ScopeGrain, string> = {
  sides: IN_SIDES,
  days: "day BETWEEN {from: Date} AND {to: Date}",
};

// The whole ISO weeks that touch the days, for the label machines.
const WEEKS: Record<ScopeGrain, string> = {
  sides: `(day BETWEEN toMonday({a_from: Date}) AND toMonday({a_to: Date}) + 6
        OR day BETWEEN toMonday({b_from: Date}) AND toMonday({b_to: Date}) + 6)`,
  days: "day BETWEEN toMonday({from: Date}) AND toMonday({to: Date}) + 6",
};

// What a child of the scope is named by, in the answer's terms: an owner
// (or bucket), a machine (or Unknown machine), a test file, an environment
// and workflow (a lane), or a runner label and workflow.
const CHILD: Record<ScopeBy, string> = {
  o: "owner",
  m: "machine",
  f: "test_file",
  lane: "concat(toString(environments_id), '|', workflow)",
  label: "concat(label, '|', workflow)",
};

// The parameters a trail binds: one value per pill's dimension.
export function trailParams(trail: readonly Pill[]): Record<string, string> {
  return Object.fromEntries(trail.map((p) => [`pill_${p.dim}`, p.value]));
}

// The shared query of /scope and /series: the runner-hours of a trail's
// scope by child (by) and runner label, per side and piece (sides) or per
// day (days), all of them and those of pushes to main, with executed and
// skipped test hours for files and lanes. One machine definition for both:
// the environment's machine when the rows have test reports, else the
// machine the runner label's reporting rows ran on most in that ISO week
// (weekLabelMachines), else Unknown machine. Owners are those of ci.owners,
// read now, split evenly, or the buckets, as the trend splits them.
//
// The rows are summed first by side and piece (or day), test file,
// environment, runner label and workflow, keeping only the keys the scope
// needs, so the machine and owner joins read a row per group rather than per
// stored row. Pieces are a side's days inside one ISO week and one calendar
// month, from piece_from, for pricing by week or month without a day
// dimension; a piece's week names its label machine.
export function scopeQuery(
  grain: ScopeGrain,
  trail: readonly Pill[],
  by: ScopeBy
): string {
  const has = (dim: Pill["dim"]) => trail.some((p) => p.dim === dim);
  const needMachine = by === "m" || has("m");
  const needOwner = by === "o" || has("o");
  const needFile = needOwner || by === "f";
  const needEnv = needMachine || by === "lane";
  const needWorkflow = by === "lane" || by === "label";
  const needTests = by === "f" || by === "lane";
  const time = grain === "sides" ? ["side", "piece_from"] : ["day_utc_date"];
  const keys = [
    ...time,
    ...(needMachine ? ["week"] : []),
    ...(needFile ? ["test_file"] : []),
    ...(needEnv ? ["environments_id"] : []),
    "label",
    ...(needWorkflow ? ["workflow"] : []),
  ];
  const values = [
    "ms",
    "main_ms",
    ...(needTests ? ["executed_ms", "skipped_ms"] : []),
  ];
  const selects = [
    ...(grain === "sides"
      ? [
          SIDES.replace(/\n/g, "\n    "),
          `greatest(toMonday(day), toStartOfMonth(day),
        if(side = 0, {a_from: Date}, {b_from: Date})) AS piece_from`,
        ]
      : ["day AS day_utc_date"]),
    ...(needMachine ? ["toMonday(day) AS week"] : []),
    ...(needFile ? ["test_file"] : []),
    ...(needEnv ? ["environments_id"] : []),
    "arrayStringConcat(runner_labels, ',') AS label",
    ...(needWorkflow ? [`${WORKFLOW} AS workflow`] : []),
    "sum(occupancy_runner_milliseconds) AS ms",
    MAIN_MS,
    ...(needTests
      ? [
          "sum(executed_test_milliseconds) AS executed_ms",
          "sum(skipped_test_milliseconds) AS skipped_ms",
        ]
      : []),
  ];
  const fileFilter = has("f") ? "\n      AND test_file = {pill_f: String}" : "";
  const ctes = [
    ...(needMachine
      ? [ENV_MACHINES, weekLabelMachines(WEEKS[grain].replace(/\n/g, "\n  "))]
      : []),
    `cells AS (
    SELECT ${selects.join(",\n      ")}
    FROM ${TEST_COST}
    WHERE repo = {repo: String}
      AND ${DAYS[grain]}
      AND ${IN_SCOPE}${fileFilter}
      AND ${latestDayRows(DAYS[grain])}
    GROUP BY ${keys.join(", ")}
  )`,
  ];
  // Explicit columns at every stage: the database's analyzer cannot expand
  // c.* of a source that joins.
  const columns = (alias: string, names: string[]) =>
    names.map((n) => `${alias}.${n} AS ${n}`).join(", ");
  let source = "cells";
  let sourceColumns = [...keys, ...values];
  if (needMachine) {
    source = `(
    SELECT ${columns("p", sourceColumns)},
      multiIf(em.machine != '', em.machine, wl.machine != '', wl.machine,
        '${UNKNOWN_MACHINE}') AS machine
    FROM cells AS p
    LEFT JOIN env_machines AS em ON em.id = p.environments_id
    LEFT JOIN week_label_machines AS wl ON wl.week = p.week AND wl.label = p.label
  )`;
    sourceColumns = [...sourceColumns, "machine"];
  }
  const filters = [
    ...(has("m") ? ["machine = {pill_m: String}"] : []),
    ...(has("o") ? ["owner = {pill_o: String}"] : []),
  ];
  let from = source;
  if (needOwner) {
    from = `(
  SELECT ${columns("c", sourceColumns)},
    multiIf(c.test_file = '', ['unattributed:no_test_reports'],
      empty(o.owners), ['unattributed:no_owner'], o.owners) AS owner_list
  FROM ${source.replace(/\n/g, "\n  ")} AS c
  LEFT JOIN (
    SELECT file, owners FROM ${CI_DATABASE}.owners FINAL WHERE repo = {repo: String}
  ) AS o ON o.file = c.test_file
)
ARRAY JOIN owner_list AS owner`;
  }
  const share = needOwner ? " / length(owner_list)" : "";
  const value = (column: string, alias: string) =>
    `round(sum(${column}${share}) / 3600000, 4) AS ${alias}`;
  const outTime =
    grain === "sides"
      ? ["side", "toString(piece_from) AS piece"]
      : ["toString(day_utc_date) AS day_utc"];
  const groupTime = grain === "sides" ? ["side", "piece"] : ["day_utc"];
  return `
WITH
  ${ctes.join(",\n  ")}
SELECT ${[
    ...outTime,
    `${CHILD[by]} AS child`,
    "label",
    value("ms", "runner_hours"),
    value("main_ms", "main_runner_hours"),
    ...(needTests
      ? [
          value("executed_ms", "executed_hours"),
          value("skipped_ms", "skipped_hours"),
        ]
      : []),
  ].join(",\n  ")}
FROM ${from}${filters.length > 0 ? `\nWHERE ${filters.join(" AND ")}` : ""}
GROUP BY ${[...groupTime, "child", "label"].join(", ")}
HAVING runner_hours > 0${needTests ? " OR executed_hours > 0" : ""}
SETTINGS join_use_nulls = 0`;
}

// The days of A and B (sides) or of the range (days) the rollup holds, what
// per-day figures divide by, each still filling or not (as the trend says:
// last computed less than FILLING_HOURS after it began), with its pushes to
// main (distinct head commits pushed to main or master, by their day).
export function scopeDaysQuery(grain: ScopeGrain): string {
  const pushDays =
    grain === "sides"
      ? `(head_commit.timestamp >= {a_from: Date} AND head_commit.timestamp < {a_to: Date} + 1
      OR head_commit.timestamp >= {b_from: Date} AND head_commit.timestamp < {b_to: Date} + 1)`
      : "head_commit.timestamp >= {from: Date} AND head_commit.timestamp < {to: Date} + 1";
  return `
SELECT toString(d.day) AS day_utc, d.filling AS filling, p.pushes AS pushes
FROM (
  SELECT day,
    max(computed_at) < addHours(toDateTime(day, 'UTC'), ${FILLING_HOURS}) AS filling
  FROM ${TEST_COST}
  WHERE repo = {repo: String} AND ${DAYS[grain]}
  GROUP BY day
) AS d
LEFT JOIN (
  SELECT toDate(head_commit.timestamp) AS day,
    uniqExact(head_commit.id) AS pushes
  FROM default.push
  WHERE ${MAIN_PUSHES}
    AND ${pushDays}
  GROUP BY day
) AS p ON p.day = d.day
SETTINGS join_use_nulls = 0`;
}

// Files with more than one owner (ci.owners, read now): a file child's
// co-owners.
export function coOwnersQuery(): string {
  return `
SELECT file, owners FROM ${CI_DATABASE}.owners FINAL
WHERE repo = {repo: String} AND length(owners) > 1`;
}

// Every environment of the catalog, as the tests API maps it: a lane's
// environment.
export function environmentsQuery(): string {
  return `
SELECT toString(id) AS environment_id_string, os, os_version, cpu_architecture,
  cpu_capability, python_version, cc_compiler, cc_compiler_version, accelerator,
  accelerator_version, device_name, device_count,
  first_seen_at AS environment_first_seen_at
FROM ${CI_DATABASE}.environments FINAL`;
}

export interface ScopeRow {
  side?: number | string;
  piece?: string;
  day_utc?: string;
  child: string;
  label: string;
  runner_hours: number | string;
  main_runner_hours: number | string;
  executed_hours?: number | string;
  skipped_hours?: number | string;
}

export interface ScopeDayRow {
  day_utc: string;
  filling: number | boolean | string;
  pushes: number | string;
}

interface MachineRow {
  machine: string;
  family: string;
  device: string;
  cpu: string;
}

interface CoOwnersRow {
  file: string;
  owners: string[];
}

// Names by their hours, most first, then by name.
export function rankedNames(hours: Map<string, number>): string[] {
  return Array.from(hours)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name]) => name);
}

const lastOfMonth = (day: Day): Day => {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
};
const mondayOf = (day: Day): Day => {
  const d = new Date(`${day}T00:00:00Z`);
  return addDays(day, -((d.getUTCDay() + 6) % 7));
};

// The piece of a side starting on from: through the earliest of its week's
// Sunday, its month's last day and the side's last day.
export function pieceOf(side: 0 | 1, from: Day, range: DayRange): ScopePiece {
  const ends = [addDays(mondayOf(from), 6), lastOfMonth(from), range.to];
  return { side, from, to: ends.sort()[0] };
}

// A side's days as the answer holds them: the days the rollup holds inside
// the side, ascending, each with its pushes, and those still filling.
export function scopeSide(dayRows: ScopeDayRow[], range: DayRange): ScopeSide {
  const rows = dayRows
    .filter((r) => r.day_utc >= range.from && r.day_utc <= range.to)
    .sort((x, y) => (x.day_utc < y.day_utc ? -1 : 1));
  return {
    days: rows.map((r) => r.day_utc),
    pushes: rows.map((r) => Number(r.pushes) || 0),
    filling: rows
      .filter((r) => Number(r.filling) === 1 || r.filling === true)
      .map((r) => r.day_utc),
  };
}

// The scope's children's details: a machine's family and names, a file's
// co-owners, a lane's environment and workflow, a label's label and workflow.
export function childInfo(
  by: ScopeBy,
  children: string[],
  hours: Map<string, number>,
  machines: MachineRow[],
  coOwners: CoOwnersRow[],
  environments: EnvironmentRow[]
): ScopeChildInfo[] {
  if (by === "m") {
    // Devices shorten against every machine of the catalog, so a machine
    // has one short name at every level of the drill.
    const described = costMachines(
      machines.map((m) => ({
        owner: "",
        workflow: "",
        machine: m.machine,
        machine_source: "environment" as const,
        label: "",
        file: "",
        runner_hours: hours.get(m.machine) ?? 0,
      })),
      machines
    );
    const byName = new Map(described.map((m) => [m.machine, m]));
    const details = new Map(machines.map((m) => [m.machine, m]));
    return children.map((child) => {
      const m = byName.get(child);
      const d = details.get(child);
      if (m === undefined) return {};
      return {
        family: m.family,
        short: m.short,
        ...(d?.device ? { device: d.device } : {}),
        ...(d?.cpu ? { cpu: d.cpu } : {}),
      };
    });
  }
  if (by === "f") {
    const owners = new Map(coOwners.map((r) => [r.file, r.owners]));
    return children.map((child) => {
      const list = owners.get(child);
      return list !== undefined && list.length > 1
        ? { coOwners: [...list].sort() }
        : {};
    });
  }
  if (by === "lane") {
    const envs = new Map(
      environments.map((r) => [r.environment_id_string, toEnvironment(r)])
    );
    return children.map((child) => {
      const [env, workflow] = splitPair(child);
      const environment = envs.get(env);
      return { ...(environment ? { environment } : {}), workflow };
    });
  }
  if (by === "label") {
    return children.map((child) => {
      const [label, workflow] = splitPair(child);
      return { label, workflow };
    });
  }
  return children.map(() => ({}));
}

// "a|b" as [a, b], split on the last bar: workflows have none.
function splitPair(child: string): [string, string] {
  const at = child.lastIndexOf("|");
  return at < 0 ? [child, ""] : [child.slice(0, at), child.slice(at + 1)];
}

// The query rows as /scope answers them: children and labels most hours
// first (then by name), pieces by side and start, cells and test hours as
// index tuples in side, piece, child and label order.
export function compactScope(
  by: ScopeBy,
  a: DayRange,
  b: DayRange,
  rows: ScopeRow[],
  dayRows: ScopeDayRow[]
): Pick<
  CostScope,
  "sides" | "pieces" | "children" | "labels" | "cells" | "tests"
> & { hours: Map<string, number> } {
  const kept = rows.map((r) => ({
    side: Number(r.side) as 0 | 1,
    piece: String(r.piece),
    child: r.child,
    label: r.label,
    h: Number(r.runner_hours),
    mainH: Number(r.main_runner_hours),
    executedH: Number(r.executed_hours ?? 0),
    skippedH: Number(r.skipped_hours ?? 0),
  }));
  const childHours = new Map<string, number>();
  const labelHours = new Map<string, number>();
  for (const r of kept) {
    childHours.set(r.child, (childHours.get(r.child) ?? 0) + r.h);
    labelHours.set(r.label, (labelHours.get(r.label) ?? 0) + r.h);
  }
  const children = rankedNames(childHours);
  const labels = rankedNames(labelHours);
  const ranges: [DayRange, DayRange] = [a, b];
  const pieceKeys = Array.from(
    new Set(kept.map((r) => `${r.side}|${r.piece}`))
  ).sort();
  const pieces = pieceKeys.map((key) => {
    const side = Number(key.slice(0, 1)) as 0 | 1;
    return pieceOf(side, key.slice(2), ranges[side]);
  });
  const pieceIndex = new Map(pieceKeys.map((k, i) => [k, i]));
  const childIndex = new Map(children.map((c, i) => [c, i]));
  const labelIndex = new Map(labels.map((l, i) => [l, i]));
  const cells: CostScope["cells"] = kept
    .filter((r) => r.h > 0)
    .map(
      (r) =>
        [
          r.side,
          pieceIndex.get(`${r.side}|${r.piece}`) as number,
          childIndex.get(r.child) as number,
          labelIndex.get(r.label) as number,
          r.h,
          r.mainH,
        ] as [number, number, number, number, number, number]
    )
    .sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3]);
  const tests: CostScope["tests"] = [];
  if (by === "f" || by === "lane") {
    const sums = new Map<string, [number, number, number, number]>();
    for (const r of kept) {
      const key = `${r.side}|${r.child}`;
      const t = sums.get(key) ?? [
        r.side,
        childIndex.get(r.child) as number,
        0,
        0,
      ];
      t[2] += r.executedH;
      t[3] += r.skippedH;
      sums.set(key, t);
    }
    for (const t of Array.from(sums.values())) {
      tests.push([t[0], t[1], round4(t[2]), round4(t[3])]);
    }
    tests.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  }
  return {
    sides: [scopeSide(dayRows, a), scopeSide(dayRows, b)],
    pieces,
    children,
    labels,
    cells,
    tests,
    hours: childHours,
  };
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

export async function getCostScope(
  params: CostScopeParams
): Promise<CostScope> {
  const a = parseDayRange(params.a);
  const b = parseDayRange(params.b);
  // The parameters' own check; here for the types.
  if (a === null || b === null) throw new Error("Invalid periods");
  const workflows = params.workflow ?? [];
  const trail = params.trail;
  const by = params.by;
  const bound = {
    repo: params.repo,
    a_from: a.from,
    a_to: a.to,
    b_from: b.from,
    b_to: b.to,
  };
  const started = performance.now();
  // About a second for a week a side, a few for a year a side
  // (query-validation.md): not a heavy query.
  const [rows, dayRows, machines, coOwners, environments]: [
    ScopeRow[],
    ScopeDayRow[],
    MachineRow[],
    CoOwnersRow[],
    EnvironmentRow[]
  ] = await Promise.all([
    queryClickhouse(
      scopeQuery("sides", trail, by),
      { ...bound, workflows, ...trailParams(trail) },
      "tests_cost_scope"
    ),
    queryClickhouse(scopeDaysQuery("sides"), bound, "tests_cost_scope_days"),
    by === "m"
      ? queryClickhouse(machinesQuery(), {}, "tests_cost_scope_machines")
      : Promise.resolve([]),
    by === "f"
      ? queryClickhouse(
          coOwnersQuery(),
          { repo: params.repo },
          "tests_cost_scope_owners"
        )
      : Promise.resolve([]),
    by === "lane"
      ? queryClickhouse(environmentsQuery(), {}, "tests_cost_scope_envs")
      : Promise.resolve([]),
  ]);
  const compact = compactScope(by, a, b, rows, dayRows);
  return {
    repo: params.repo,
    workflows,
    trail,
    by,
    a,
    b,
    sides: compact.sides,
    pieces: compact.pieces,
    children: compact.children,
    info: childInfo(
      by,
      compact.children,
      compact.hours,
      machines,
      coOwners,
      environments
    ),
    labels: compact.labels,
    cells: compact.cells,
    tests: compact.tests,
    query_duration_ms: Math.round(performance.now() - started),
  };
}
