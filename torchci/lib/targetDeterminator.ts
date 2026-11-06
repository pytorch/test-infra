// Query names, constants and formulas behind the Target Determinator page, and
// the part of the picked window each section counts.

import { useClickHouseAPI } from "lib/GeneralUtils";
import { NO_DATA_IN_WINDOW } from "lib/greenlight/qualityFigures";
import {
  type BreakageRow,
  num,
  type RankRow,
  ratio,
  readTdQuery,
  type SavingsRow,
  type TdQueryState,
  totalRow,
} from "lib/targetDeterminatorRows";

// Where TD is on. The queries hardcode the same lists (test/targetDeterminator
// checks the literals); td_trunk_breakages also takes tdWorkflows as a param.
export const TD_SCOPE = {
  tdWorkflows: ["pull", "trunk"] as const,
  tdWorkflowPrefixes: ["rocm-", "periodic-rocm-"],
  noTdBuildMarkers: ["macos", "xpu", "onnx"],
};

export type TdWorkflow = (typeof TD_SCOPE.tdWorkflows)[number];

export const REVERT_WINDOW_DAYS = 7;
export const NEW_TEST_DAYS = 14;
export const TD_CUT_PCT = 25;
export const MIN_MAIN_RUNS = 5;

// PR test jobs before this UTC day are named "<build> / test-osdc (...)", which
// matches neither the same job on main nor the PR jobs a breaking test ran in.
// td_ci_savings, td_push_wait and td_trunk_breakages floor at the same day.
export const JOB_NAMES_VALID_FROM = "2026-07-13";
// tests.all_test_runs_by_name starts 2026-08-26 19:35 UTC and the new-test
// probe reads 3 days ending 14 days before the landing, so before this day a
// new test reads as skipped by TD: false greens there are an upper bound.
export const NEW_TEST_CHECK_FROM = "2026-09-12";
// misc.ossci_uploaded_metrics holds no TD rankings before 2026-08-06 22:28 UTC,
// so this is the first whole UTC day of them.
export const RANKS_DATA_FROM = "2026-08-07";
// default.test_run_summary holds no rows before 2026-10-05 22:37 UTC. A
// stability pair reads its earlier push up to STABILITY_LOOK_BACK_DAYS before
// the later one, so this is the first day whose look-back lies inside the data.
export const STABILITY_DATA_FROM = "2026-10-20";
export const STABILITY_LOOK_BACK_DAYS = 14;
// td_selection_churn's hist rows count changes in buckets this many points
// wide.
export const CHANGE_BUCKET_PCT = 0.1;

// The widest window each query reads; the SQL clamps to the same widths.
// Breakages, ranks and stability read longer windows in chunks of this size.
export const CLAMP_DAYS = {
  savings: 365,
  pushWait: 365,
  breakages: 90,
  ranks: 90,
  stability: 49,
};

// How long the source tables keep their rows.
const RETENTION_DAYS = {
  ranks: 730,
  stability: 365,
};

// Shown wherever a breakage figure waits for its revert window to close.
export const PENDING_NOTE = `Not yet counted: landings from the last ${REVERT_WINDOW_DAYS} days may still be reverted.`;
// Under a figure whose rows hold nothing to compute it from; a figure without
// rows says NO_DATA_IN_WINDOW instead.
export const NOTHING_TO_MEASURE = "Nothing to measure in this range";

// Below this share of PR jobs with a main baseline, the estimate describes too
// small a slice of PR CI to stand for it.
const MIN_BASELINE_COVERAGE = 0.5;

export const DAY_MS = 86400000;

export const TD_QUERIES = {
  savings: "td_ci_savings",
  pushWait: "td_push_wait",
  breakages: "td_trunk_breakages",
  ranks: "td_failure_ranks",
  churn: "td_selection_churn",
};

// Whole UTC days in ClickHouse's DateTime64(3) literal form.
export type TdParams = {
  startTime: string;
  stopTime: string;
};

export function parseUtc(time: string): number {
  return Date.parse(`${time}Z`);
}

export function utcText(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "");
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export interface RangeLimit {
  validFrom?: number;
  validReason?: string;
  clampDays?: number;
}

// The part of the picked window a section counts. params are the query's
// parameters, undefined when there is nothing to count: the stop stays the
// picked one, so the SWR key does not move with the clock. end is where data
// stops, min(stop, now).
export interface CountedRange {
  params?: TdParams;
  start: number;
  end: number;
  empty: boolean;
  note?: string;
}

function todayEnd(now: number): number {
  return dayStart(utcDay(now)) + DAY_MS;
}

// Whole UTC days, so the first counted day is kept in full and the key changes
// once a day.
function retainedFrom(days: number, now: number): number {
  return todayEnd(now) - days * DAY_MS;
}

export function readsAtMost(days: number | undefined): string {
  return `This section reads at most ${days} days at a time.`;
}

export function sectionLimits(now: number = Date.now()) {
  return {
    savings: {
      validFrom: dayStart(JOB_NAMES_VALID_FROM),
      validReason: `Test jobs had other names before ${JOB_NAMES_VALID_FROM}, so earlier PR jobs cannot be matched with main.`,
      clampDays: CLAMP_DAYS.savings,
    },
    breakages: {
      validFrom: dayStart(JOB_NAMES_VALID_FROM),
      validReason: `Test jobs had other names before ${JOB_NAMES_VALID_FROM}, so earlier breaking tests cannot be matched with the PR's jobs.`,
    },
    ranks: {
      validFrom: Math.max(
        dayStart(RANKS_DATA_FROM),
        retainedFrom(RETENTION_DAYS.ranks, now)
      ),
      validReason: `TD's rankings are kept from ${RANKS_DATA_FROM}, for 2 years.`,
    },
    stability: {
      validFrom: Math.max(
        dayStart(STABILITY_DATA_FROM),
        retainedFrom(RETENTION_DAYS.stability - STABILITY_LOOK_BACK_DAYS, now)
      ),
      validReason: `Run-to-run data is complete from ${STABILITY_DATA_FROM} and kept for a year.`,
    },
  } satisfies Record<string, RangeLimit>;
}

export function countedRange(
  params: TdParams,
  limit: RangeLimit,
  now: number = Date.now()
): CountedRange {
  const picked = parseUtc(params.startTime);
  const stop = parseUtc(params.stopTime);
  const validFrom = limit.validFrom ?? -Infinity;
  // The SQL clamps back from least(stop, now); a whole UTC day past now keeps
  // the key fixed through the day while a future stop narrows nothing.
  const clampFrom =
    limit.clampDays === undefined
      ? -Infinity
      : Math.min(stop, todayEnd(now)) - limit.clampDays * DAY_MS;
  const start = Math.max(picked, validFrom, clampFrom);
  const end = Math.min(stop, now);
  const empty = !(start < end);
  return {
    params: empty
      ? undefined
      : { startTime: utcText(start), stopTime: params.stopTime },
    start,
    end,
    empty,
    note:
      start <= picked
        ? undefined
        : validFrom >= clampFrom
        ? limit.validReason
        : readsAtMost(limit.clampDays),
  };
}

// The first and last UTC day the range holds data for.
export function rangeText(range: { start: number; end: number }): string {
  return `${utcDay(range.start)} to ${utcDay(range.end - 1)}`;
}

export function countedText(range: { start: number; end: number }): string {
  return `Counted ${rangeText(range)} (UTC).`;
}

export function withNote(
  range: CountedRange,
  note: string | undefined
): CountedRange {
  return note === undefined
    ? range
    : {
        ...range,
        note: [range.note, note].filter((n) => n !== undefined).join(" "),
      };
}

export function ciSaved(row: SavingsRow | undefined): number | null {
  const pr = num(row?.pr_hours);
  const full = num(row?.est_full_hours);
  if (pr === null || full === null || full === 0) {
    return null;
  }
  return 1 - pr / full;
}

// A savings row's CI-saved share, gated on that row's own baseline coverage,
// and the line under it; a missing row reads as an empty window.
export function savedShare(row: SavingsRow | undefined): {
  value: number | null;
  sub?: string;
} {
  const jobs = num(row?.jobs) ?? 0;
  const unmatched = num(row?.unmatched_jobs) ?? 0;
  const coverage = ratio(jobs, jobs + unmatched);
  const lowCoverage = coverage !== null && coverage < MIN_BASELINE_COVERAGE;
  const value = lowCoverage ? null : ciSaved(row);
  return {
    value,
    sub:
      jobs === 0
        ? NO_DATA_IN_WINDOW
        : lowCoverage
        ? "Too few jobs to estimate"
        : value === null
        ? NOTHING_TO_MEASURE
        : undefined,
  };
}

export interface BreakageStats {
  falseGreens: number;
  recall: number | null;
  recallBase: number;
}

export function breakageStats(
  row: Partial<BreakageRow> | undefined
): BreakageStats {
  const count = (key: keyof BreakageRow) => num(row?.[key]) ?? 0;
  const falseGreens = count("false_green");
  const ranOnPr = count("signal_on_pr") + count("passed_on_pr");
  const recallBase = ranOnPr + falseGreens;
  return {
    falseGreens,
    recall: ratio(ranOnPr, recallBase),
    recallBase,
  };
}

// The grouped (interpolated) median of the hist rows, whose buckets are width
// wide: L + width * (n / 2 - C) / f, where the bucket holding the median starts
// at L and counts f items, C items lie in lower buckets and n in all of them.
// Buckets repeated across chunks add up.
export function histMedian<T extends { grain: string }>(
  rows: T[],
  bucketColumn: keyof T,
  countColumn: keyof T,
  width: number
): number | null {
  const perBucket = new Map<number, number>();
  for (const row of rows) {
    if (row.grain !== "hist") {
      continue;
    }
    const bucket = num(row[bucketColumn]);
    const count = num(row[countColumn]);
    if (bucket === null || count === null || count <= 0) {
      continue;
    }
    perBucket.set(bucket, (perBucket.get(bucket) ?? 0) + count);
  }
  const total = [...perBucket.values()].reduce((sum, n) => sum + n, 0);
  let below = 0;
  for (const bucket of [...perBucket.keys()].sort((a, b) => a - b)) {
    const count = perBucket.get(bucket) ?? 0;
    if (2 * (below + count) >= total) {
      return bucket + (width * (total / 2 - below)) / count;
    }
    below += count;
  }
  return null;
}

// td_failure_ranks lists only the newest landings of each chunk it answers.
export function landingsMissing(states: TdQueryState<RankRow>[]): boolean {
  return states.some(
    (state) =>
      state.rows.filter((row) => row.grain === "landing").length <
      (num(totalRow(state.rows)?.landings) ?? 0)
  );
}

export function minutesText(value: unknown): string {
  const minutes = num(value);
  return minutes === null ? "-" : `${minutes.toFixed(0)} min`;
}

export function hoursText(value: unknown): string {
  const hours = num(value);
  return hours === null
    ? "-"
    : `${hours.toLocaleString(undefined, {
        maximumFractionDigits: Math.abs(hours) >= 100 ? 0 : 1,
      })} h`;
}

// The window is snapped to whole UTC days, and these queries are too heavy to
// re-run on focus, on reconnect or after a failure.
const TD_SWR_CONFIG = {
  revalidateIfStale: false,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  shouldRetryOnError: false,
};

// No window, nothing to read: an empty counted range, or a chunk slot that is
// unused or held back.
export function useTdQuery<T>(
  queryName: string,
  window: TdParams | undefined,
  extra: Record<string, unknown> = {}
): TdQueryState<T> {
  const enabled = window !== undefined;
  const { data, error } = useClickHouseAPI<T>(
    queryName,
    { startTime: window?.startTime, stopTime: window?.stopTime, ...extra },
    enabled,
    TD_SWR_CONFIG
  );
  return readTdQuery<T>(queryName, data, error, enabled);
}
