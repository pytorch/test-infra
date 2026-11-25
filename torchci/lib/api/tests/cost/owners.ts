import { queryClickhouse } from "lib/api/tests/clickhouse";
import type { CostOwners, Day } from "lib/api/tests/cost/contracts";
import type { CostOwnersParams } from "lib/api/tests/cost/parameters";
import {
  ENV_MACHINES,
  FILLING_HOURS,
  IN_SCOPE,
  latestDayRows,
  machinesQuery,
  TEST_COST,
  weekLabelMachines,
  WORKFLOW,
} from "lib/api/tests/cost/query";
import {
  costMachines,
  type MachineRow,
  METHOD,
  type RunnerHoursQueryRow,
  runnerHoursRows,
  unprobedLabels,
} from "lib/api/tests/cost/runnerHours";
import { DAYS, WEEKS } from "lib/api/tests/cost/scope";
import { CI_DATABASE } from "lib/api/tests/database";

// GET /api/tests/cost's rows over from..to and a workflow scope, machines
// named as /scope names them: the environment's; else the runner label's
// machine that ISO week (weekLabelMachines), an estimate; else none (machine
// ''). Summed first by day, file, environment, label and workflow, as
// scopeQuery sums, so the joins read a row per group; with byDay, one row per
// day too (day_utc), for prices that change on any day. Not rounded: the
// answer rounds its cells only.
export function ownersQuery(byDay: boolean): string {
  const day = byDay ? "day AS day_date, " : "";
  const dayKey = byDay ? "day_date, " : "";
  const dayOf = (alias: string) =>
    byDay ? `${alias}.day_date AS day_date, ` : "";
  return `
WITH
  ${ENV_MACHINES},
  ${weekLabelMachines(WEEKS.days)},
  cells AS (
    SELECT ${day}toMonday(day) AS week, test_file, environments_id,
      arrayStringConcat(runner_labels, ',') AS label, ${WORKFLOW} AS workflow,
      sum(occupancy_runner_milliseconds) AS ms
    FROM ${TEST_COST}
    WHERE repo = {repo: String}
      AND ${DAYS.days}
      AND ${IN_SCOPE}
      AND ${latestDayRows(DAYS.days)}
    GROUP BY ${dayKey}week, test_file, environments_id, label, workflow
  )
SELECT owner, workflow, machine, machine_source, label,${
    byDay ? " toString(day_date) AS day_utc," : ""
  }
  sum(ms / length(owner_list)) / 3600000 AS runner_hours
FROM (
  SELECT ${dayOf("m")}m.workflow AS workflow, m.label AS label, m.ms AS ms,
    m.machine AS machine, m.machine_source AS machine_source,
    multiIf(m.test_file = '', ['unattributed:no_test_reports'],
      empty(o.owners), ['unattributed:no_owner'], o.owners) AS owner_list
  FROM (
    SELECT ${dayOf(
      "p"
    )}p.test_file AS test_file, p.label AS label, p.workflow AS workflow,
      p.ms AS ms, if(em.machine != '', em.machine, wl.machine) AS machine,
      multiIf(em.machine != '', 'environment',
        wl.machine != '', 'runner_label', 'none') AS machine_source
    FROM cells AS p
    LEFT JOIN env_machines AS em ON em.id = p.environments_id
    LEFT JOIN week_label_machines AS wl ON wl.week = p.week AND wl.label = p.label
  ) AS m
  LEFT JOIN (
    SELECT file, owners FROM ${CI_DATABASE}.owners FINAL WHERE repo = {repo: String}
  ) AS o ON o.file = m.test_file
)
ARRAY JOIN owner_list AS owner
GROUP BY owner, workflow, machine, machine_source, label${
    byDay ? ", day_utc" : ""
  }
SETTINGS join_use_nulls = 0`;
}

// The range's days the rollup holds, each filling or not:
// scopeDaysQuery("days")'s days without the pushes. Not scoped by workflow:
// a day with data is a day the rollup holds, as the trend and /scope count.
export function ownersDaysQuery(): string {
  return `
SELECT toString(day) AS day_utc,
  max(computed_at) < addHours(toDateTime(day, 'UTC'), ${FILLING_HOURS}) AS filling
FROM ${TEST_COST}
WHERE repo = {repo: String} AND ${DAYS.days}
GROUP BY day
ORDER BY day`;
}

export interface OwnersQueryRow extends Omit<RunnerHoursQueryRow, "file"> {
  day_utc?: string;
}

export interface OwnersDayRow {
  day_utc: string;
  filling: number | boolean | string;
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

const rowKey = (r: Omit<OwnersQueryRow, "runner_hours" | "day_utc">) =>
  JSON.stringify([r.owner, r.workflow, r.machine, r.machine_source, r.label]);

// The query rows as /owners answers them: the days with data and those
// still filling, ascending; rows as GET /api/tests/cost folds them (days
// away, largest first); with byDay, cells [day, row, h] rounded to 0.0001 h,
// in day and row order.
export function compactOwners(
  rows: OwnersQueryRow[],
  dayRows: OwnersDayRow[],
  byDay: boolean
): Pick<CostOwners, "days" | "filling" | "rows" | "cells"> {
  const held = [...dayRows].sort((x, y) => (x.day_utc < y.day_utc ? -1 : 1));
  const days: Day[] = held.map((r) => r.day_utc);
  const filling = held
    .filter((r) => Number(r.filling) === 1 || r.filling === true)
    .map((r) => r.day_utc);
  const folded = runnerHoursRows(rows.map((r) => ({ ...r, file: "" })));
  const cells: CostOwners["cells"] = [];
  if (byDay) {
    const dayIndex = new Map(days.map((d, i) => [d, i]));
    const rowIndex = new Map(folded.map((r, i) => [rowKey(r), i]));
    const sums = new Map<string, [number, number, number]>();
    for (const r of rows) {
      const h = Number(r.runner_hours);
      const d = dayIndex.get(String(r.day_utc));
      const i = rowIndex.get(rowKey(r));
      // A day the days query lacks, or a row folded away (no hours): never
      // in practice, both read the same days of the same table.
      if (!(h > 0) || d === undefined || i === undefined) continue;
      const key = `${d}|${i}`;
      const cell = sums.get(key) ?? [d, i, 0];
      cell[2] += h;
      sums.set(key, cell);
    }
    for (const [d, i, h] of Array.from(sums.values())) {
      if (round4(h) > 0) cells.push([d, i, round4(h)]);
    }
    cells.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  }
  return { days, filling, rows: folded, cells };
}

export async function getCostOwners(
  params: CostOwnersParams
): Promise<CostOwners> {
  const workflows = params.workflow ?? [];
  const byDay = params.piece === "day";
  const bound = { repo: params.repo, from: params.from, to: params.to };
  const started = performance.now();
  // Under a second for a week, about one for 28 days (query-validation.md):
  // not a heavy query.
  const [rows, dayRows, machines]: [
    OwnersQueryRow[],
    OwnersDayRow[],
    MachineRow[]
  ] = await Promise.all([
    queryClickhouse(
      ownersQuery(byDay),
      { ...bound, workflows },
      "tests_cost_owners"
    ),
    queryClickhouse(ownersDaysQuery(), bound, "tests_cost_owners_days"),
    queryClickhouse(machinesQuery(), {}, "tests_cost_owners_machines"),
  ]);
  const compact = compactOwners(rows, dayRows, byDay);
  const withFile = rows.map((r) => ({ ...r, file: "" }));
  return {
    repo: params.repo,
    workflows,
    from: params.from,
    to: params.to,
    piece: params.piece ?? null,
    days: compact.days,
    filling: compact.filling,
    rows: compact.rows,
    machines: costMachines(withFile, machines),
    unprobed_labels: unprobedLabels(withFile),
    cells: compact.cells,
    method: METHOD,
    query_duration_ms: Math.round(performance.now() - started),
  };
}
