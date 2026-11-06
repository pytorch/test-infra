import type { CostTrendParams } from "lib/api/tests/cost/parameters";
import {
  trendDailyQuery,
  trendPushesQuery,
  trendQuery,
} from "lib/api/tests/cost/query";
import type { CostTrend } from "lib/api/tests/cost/types";
import { TREND_PERIODS, type TrendRollup } from "lib/api/tests/cost/windows";
import { queryClickhouse } from "lib/clickhouse";

const DAY_MS = 24 * 60 * 60 * 1000;

interface TrendRow {
  period: string;
  owner: string;
  label: string;
  runner_hours: number;
  // Those of pushes to main, part of runner_hours.
  main_runner_hours: number;
}

interface DailyRow {
  day_utc: string;
  label: string;
  runner_hours: number;
  main_runner_hours: number;
  // 1 while the day's jobs may still be finishing (trendDailyQuery).
  filling?: number | boolean;
}

interface PushesRow {
  day_utc: string;
  pushes: number | string;
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// The first day of the period holding a day, as the query's rollup starts it:
// the day, its Monday, or the first of its month, all UTC.
export function periodStart(rollup: TrendRollup, dayMs: number): number {
  const d = new Date(dayMs);
  if (rollup === "month") {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  if (rollup === "week") return dayMs - ((d.getUTCDay() + 6) % 7) * DAY_MS;
  return dayMs;
}

// The periods an answer covers, ending with the one holding yesterday, and
// the days the daily totals read: from January 1 of yesterday's year, or the
// first period if it starts earlier. Today is never counted: its rollup is
// still being computed.
export function trendWindow(rollup: TrendRollup, now: Date) {
  const endMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const last = periodStart(rollup, endMs - DAY_MS);
  const periods: number[] = [last];
  while (periods.length < TREND_PERIODS[rollup]) {
    const next = periods[0];
    const d = new Date(next);
    periods.unshift(
      rollup === "month"
        ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)
        : next - (rollup === "week" ? 7 : 1) * DAY_MS
    );
  }
  const yearStart = Date.UTC(new Date(endMs - DAY_MS).getUTCFullYear(), 0, 1);
  const dailyStart = Math.min(periods[0], yearStart);
  const spell = (ms: number) =>
    new Date(ms).toISOString().replace("T", " ").slice(0, 23);
  return {
    periods: periods.map(ymd),
    start: ymd(periods[0]),
    end: ymd(endMs),
    dailyStart: ymd(dailyStart),
    params: { start: spell(periods[0]), end: spell(endMs) },
    dailyParams: { start: spell(dailyStart), end: spell(endMs) },
  };
}

// Names by their runner-hours, most first, then by name.
function ranked(hours: Map<string, number>): string[] {
  return Array.from(hours)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name]) => name);
}

// The query rows as the answer holds them: owners and labels named once,
// most runner-hours first, the cells as index tuples in period, owner and
// label order, cells without hours and periods outside the window left out.
// Every day of the daily rows is a day with data, those of 0 h included;
// filling lists those still being filled, pushes each one's pushes to main.
export function compactTrend(
  periods: string[],
  rows: TrendRow[],
  dailyRows: DailyRow[],
  pushRows: PushesRow[]
): Pick<CostTrend, "owners" | "labels" | "cells"> & {
  daily: Omit<CostTrend["daily"], "start">;
} {
  const periodIndex = new Map(periods.map((p, i) => [p, i]));
  const numbers = <
    R extends { runner_hours: number; main_runner_hours: number }
  >(
    r: R
  ): R => ({
    ...r,
    runner_hours: Number(r.runner_hours),
    main_runner_hours: Number(r.main_runner_hours),
  });
  const kept = rows
    .map(numbers)
    .filter((r) => r.runner_hours > 0 && periodIndex.has(r.period));
  const dailyAll = dailyRows.map(numbers);
  const daily = dailyAll.filter((r) => r.runner_hours > 0);
  const ownerHours = new Map<string, number>();
  const labelHours = new Map<string, number>();
  for (const r of kept) {
    ownerHours.set(r.owner, (ownerHours.get(r.owner) ?? 0) + r.runner_hours);
    labelHours.set(r.label, (labelHours.get(r.label) ?? 0) + r.runner_hours);
  }
  // Labels only the daily totals hold (days before the first period) rank
  // after the periods' own.
  const dailyOnly = new Map<string, number>();
  for (const r of daily) {
    if (!labelHours.has(r.label)) {
      dailyOnly.set(r.label, (dailyOnly.get(r.label) ?? 0) + r.runner_hours);
    }
  }
  const owners = ranked(ownerHours);
  const labels = [...ranked(labelHours), ...ranked(dailyOnly)];
  const ownerIndex = new Map(owners.map((o, i) => [o, i]));
  const labelIndex = new Map(labels.map((l, i) => [l, i]));
  const cells = kept
    .map(
      (r) =>
        [
          periodIndex.get(r.period) as number,
          ownerIndex.get(r.owner) as number,
          labelIndex.get(r.label) as number,
          r.runner_hours,
          r.main_runner_hours,
        ] as [number, number, number, number, number]
    )
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const days = Array.from(new Set(dailyAll.map((r) => r.day_utc))).sort();
  const filling = Array.from(
    new Set(
      dailyAll.filter((r) => Number(r.filling) === 1).map((r) => r.day_utc)
    )
  ).sort();
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const dailyCells = daily
    .map(
      (r) =>
        [
          dayIndex.get(r.day_utc) as number,
          labelIndex.get(r.label) as number,
          r.runner_hours,
          r.main_runner_hours,
        ] as [number, number, number, number]
    )
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const pushesOn = new Map(pushRows.map((r) => [r.day_utc, Number(r.pushes)]));
  return {
    owners,
    labels,
    cells,
    daily: {
      days,
      filling,
      pushes: days.map((d) => pushesOn.get(d) ?? 0),
      cells: dailyCells,
    },
  };
}

export async function getCostTrend(
  params: CostTrendParams,
  now: Date = new Date()
): Promise<CostTrend> {
  const window = trendWindow(params.rollup, now);
  const workflows = params.workflow ?? [];
  const started = performance.now();
  // The first two read only the window's days of test_cost and run about
  // 0.4 CPU-seconds on today's rollup, and 3 for a year's months; the
  // pushes read three small columns of default.push in about a second
  // (query-validation.md). None is a heavy query.
  const [rows, dailyRows, pushRows]: [TrendRow[], DailyRow[], PushesRow[]] =
    await Promise.all([
      queryClickhouse(
        trendQuery(params.rollup),
        { repo: params.repo, workflows, ...window.params },
        "tests_cost_trend"
      ),
      queryClickhouse(
        trendDailyQuery(),
        { repo: params.repo, workflows, ...window.dailyParams },
        "tests_cost_trend_daily"
      ),
      queryClickhouse(
        trendPushesQuery(),
        { repo: params.repo, ...window.dailyParams },
        "tests_cost_trend_pushes"
      ),
    ]);
  const compact = compactTrend(window.periods, rows, dailyRows, pushRows);
  return {
    repo: params.repo,
    rollup: params.rollup,
    workflows,
    start: window.start,
    end: window.end,
    periods: window.periods,
    owners: compact.owners,
    labels: compact.labels,
    cells: compact.cells,
    daily: { start: window.dailyStart, ...compact.daily },
    query_duration_ms: Math.round(performance.now() - started),
  };
}
