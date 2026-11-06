import {
  type CostChangesParams,
  parseDayRange,
} from "lib/api/tests/cost/parameters";
import { changesDaysQuery, changesQuery } from "lib/api/tests/cost/query";
import type { CostChanges } from "lib/api/tests/cost/types";
import { queryClickhouse } from "lib/clickhouse";

interface ChangesRow {
  side: number | string;
  label: string;
  runner_hours: number | string;
  // Those of pushes to main, part of runner_hours.
  main_runner_hours: number | string;
}

interface DaysRow {
  day_utc: string;
  pushes: number | string;
}

// The query rows as the answer holds them: every label named once, most
// runner-hours first, then by name; cells as index tuples in side and label
// order with their push:main hours, cells without hours left out; the days
// ascending with their pushes to main.
export function compactChanges(
  rows: ChangesRow[],
  dayRows: DaysRow[]
): Pick<CostChanges, "days" | "labels" | "cells"> {
  const kept = rows
    .map((r) => ({
      side: Number(r.side),
      label: r.label,
      runner_hours: Number(r.runner_hours),
      main_runner_hours: Number(r.main_runner_hours),
    }))
    .filter((r) => r.runner_hours > 0);
  const hours = new Map<string, number>();
  for (const r of kept) {
    hours.set(r.label, (hours.get(r.label) ?? 0) + r.runner_hours);
  }
  const labels = Array.from(hours)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([label]) => label);
  const labelIndex = new Map(labels.map((l, i) => [l, i]));
  const cells = kept
    .map(
      (r) =>
        [
          r.side,
          labelIndex.get(r.label) as number,
          r.runner_hours,
          r.main_runner_hours,
        ] as [number, number, number, number]
    )
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const days = dayRows
    .map((r) => [r.day_utc, Number(r.pushes)] as [string, number])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { days, labels, cells };
}

export async function getCostChanges(
  params: CostChangesParams
): Promise<CostChanges> {
  const a = parseDayRange(params.a);
  const b = parseDayRange(params.b);
  // The parameters' own check; here for the types.
  if (a === null || b === null) throw new Error("Invalid periods");
  const owners = params.owner ?? [];
  const workflows = params.workflow ?? [];
  const bound = {
    repo: params.repo,
    a_from: a.from,
    a_to: a.to,
    b_from: b.from,
    b_to: b.to,
  };
  const started = performance.now();
  // Under half a second for four days each (query-validation.md), and the
  // days query a tenth of that, so neither is a heavy query.
  const [rows, dayRows]: [ChangesRow[], DaysRow[]] = await Promise.all([
    queryClickhouse(
      changesQuery(owners.length > 0),
      { ...bound, workflows, owners },
      "tests_cost_changes"
    ),
    queryClickhouse(changesDaysQuery(), bound, "tests_cost_changes_days"),
  ]);
  return {
    repo: params.repo,
    workflows,
    owners,
    a,
    b,
    ...compactChanges(rows, dayRows),
    query_duration_ms: Math.round(performance.now() - started),
  };
}
