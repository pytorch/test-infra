import { queryClickhouse } from "lib/api/tests/clickhouse";
import {
  type CostSeries,
  type ScopeBy,
  SERIES_TOP,
} from "lib/api/tests/cost/contracts";
import type { CostSeriesParams } from "lib/api/tests/cost/parameters";
import {
  rankedNames,
  type ScopeDayRow,
  scopeDaysQuery,
  scopeQuery,
  type ScopeRow,
  scopeSide,
  trailParams,
} from "lib/api/tests/cost/scope";

// Children that fold past SERIES_TOP: files, lanes and labels run to
// hundreds, owners and machines to tens.
const FOLDS: ReadonlySet<ScopeBy> = new Set<ScopeBy>(["f", "lane", "label"]);

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

// The query rows as /series answers them: the range's days with data, their
// pushes and those still filling; children and labels most hours first; for
// files, lanes and labels the SERIES_TOP largest children, the rest summed
// into a last child '' (rest); cells as index tuples in day, child and label
// order.
export function compactSeries(
  by: ScopeBy,
  range: { from: string; to: string },
  rows: ScopeRow[],
  dayRows: ScopeDayRow[]
): Pick<
  CostSeries,
  "days" | "pushes" | "filling" | "children" | "rest" | "labels" | "cells"
> {
  const side = scopeSide(dayRows, range);
  const kept = rows
    .map((r) => ({
      day: String(r.day_utc),
      child: r.child,
      label: r.label,
      h: Number(r.runner_hours),
      mainH: Number(r.main_runner_hours),
    }))
    .filter((r) => r.h > 0);
  const childHours = new Map<string, number>();
  const labelHours = new Map<string, number>();
  for (const r of kept) {
    childHours.set(r.child, (childHours.get(r.child) ?? 0) + r.h);
    labelHours.set(r.label, (labelHours.get(r.label) ?? 0) + r.h);
  }
  let children = rankedNames(childHours);
  const rest = FOLDS.has(by) && children.length > SERIES_TOP;
  if (rest) children = [...children.slice(0, SERIES_TOP), ""];
  const labels = rankedNames(labelHours);
  const dayIndex = new Map(side.days.map((d, i) => [d, i]));
  const childIndex = new Map(children.map((c, i) => [c, i]));
  const labelIndex = new Map(labels.map((l, i) => [l, i]));
  const sums = new Map<string, [number, number, number, number, number]>();
  for (const r of kept) {
    const day = dayIndex.get(r.day);
    if (day === undefined) continue;
    const child = childIndex.get(r.child) ?? (rest ? children.length - 1 : -1);
    if (child < 0) continue;
    const label = labelIndex.get(r.label) as number;
    const key = `${day}|${child}|${label}`;
    const cell = sums.get(key) ?? [day, child, label, 0, 0];
    cell[3] += r.h;
    cell[4] += r.mainH;
    sums.set(key, cell);
  }
  const cells: CostSeries["cells"] = Array.from(sums.values())
    .map(
      (c) =>
        [c[0], c[1], c[2], round4(c[3]), round4(c[4])] as [
          number,
          number,
          number,
          number,
          number
        ]
    )
    .sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  return {
    days: side.days,
    pushes: side.pushes,
    filling: side.filling,
    children,
    rest,
    labels,
    cells,
  };
}

export async function getCostSeries(
  params: CostSeriesParams
): Promise<CostSeries> {
  const workflows = params.workflow ?? [];
  const range = { from: params.from, to: params.to };
  const bound = { repo: params.repo, ...range };
  const started = performance.now();
  // About a second for six weeks of a pair's files; a year of every owner's
  // days reads the year's rows once (query-validation.md): not a heavy query.
  const [rows, dayRows]: [ScopeRow[], ScopeDayRow[]] = await Promise.all([
    queryClickhouse(
      scopeQuery("days", params.trail, params.by),
      { ...bound, workflows, ...trailParams(params.trail) },
      "tests_cost_series"
    ),
    queryClickhouse(scopeDaysQuery("days"), bound, "tests_cost_series_days"),
  ]);
  return {
    repo: params.repo,
    workflows,
    trail: params.trail,
    by: params.by,
    from: params.from,
    to: params.to,
    ...compactSeries(params.by, range, rows, dayRows),
    query_duration_ms: Math.round(performance.now() - started),
  };
}
