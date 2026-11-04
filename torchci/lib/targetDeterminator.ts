// Query names, constants and formulas behind the Target Determinator page, the
// part of the picked window each section counts, and the breakage chunk grid.

import { useClickHouseAPI } from "lib/GeneralUtils";
import {
  type BreakageRow,
  type Chunk,
  num,
  type RankRow,
  ratio,
  readTdQuery,
  type SavingsRow,
  type TdQueryState,
} from "lib/targetDeterminatorRows";

// Where TD is on. The queries hardcode the same lists (test/targetDeterminator
// checks the literals); td_trunk_breakages also takes tdWorkflows as a param.
export const TD_SCOPE = {
  tdWorkflows: ["pull", "trunk"],
  tdWorkflowPrefixes: ["rocm-", "periodic-rocm-"],
  noTdBuildMarkers: ["macos", "xpu", "onnx"],
};

export const REVERT_WINDOW_DAYS = 7;
export const NEW_TEST_DAYS = 14;
export const TD_CUT_PCT = 25;
export const MIN_MAIN_RUNS = 5;
export const SMALL_SAMPLE = 30;

// PR test jobs before this UTC day are named "<build> / test-osdc (...)", which
// matches neither the same job on main nor the PR jobs a breaking test ran in.
// td_ci_savings, td_push_wait and td_trunk_breakages floor at the same day.
export const JOB_NAMES_VALID_FROM = "2026-07-13";
// tests.all_test_runs_by_name starts 2026-08-26 19:35 UTC and the new-test
// probe reads 3 days ending 14 days before the landing, so before this day a
// new test reads as skipped by TD: false greens there are an upper bound.
export const NEW_TEST_CHECK_FROM = "2026-09-12";

// The widest window each query reads; the SQL clamps to the same widths.
// ttrs_percentiles has no clamp or execution cap of its own and reads tens of
// GB per month, so the page keeps it to the last 30 days of the window.
export const CLAMP_DAYS = {
  savings: 365,
  pushWait: 365,
  breakages: 90,
  ranks: 90,
  stability: 30,
  ttrs: 30,
};

// td_trunk_breakages reads at most CLAMP_DAYS.breakages, so longer windows are
// fetched in chunks of that size, on a grid fixed at JOB_NAMES_VALID_FROM so a
// chunk whose revert windows have closed keeps its SWR key and its answer.
export const CHUNK_DAYS = CLAMP_DAYS.breakages;
export const MAX_CHUNKS = 6;

// How long the source data is kept: older windows have nothing left to read.
const RETENTION_DAYS = {
  ranks: 90,
  stability: 30,
};

export const DAY_MS = 86400000;

export const TD_QUERIES = {
  savings: "td_ci_savings",
  pushWait: "td_push_wait",
  breakages: "td_trunk_breakages",
  ranks: "td_failure_ranks",
  churn: "td_selection_churn",
  ttrs: "ttrs_percentiles",
};

const PYTORCH_REPO_URL = "https://github.com/pytorch/pytorch";

// Whole UTC days in ClickHouse's DateTime64(3) literal form.
export type TdParams = {
  startTime: string;
  stopTime: string;
};

function parseUtc(time: string): number {
  return Date.parse(`${time}Z`);
}

function utcText(ms: number): string {
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

function readsAtMost(days: number | undefined): string {
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
      validFrom: retainedFrom(RETENTION_DAYS.ranks, now),
      validReason: `TD's rankings are kept for ${RETENTION_DAYS.ranks} days.`,
      clampDays: CLAMP_DAYS.ranks,
    },
    stability: {
      validFrom: retainedFrom(RETENTION_DAYS.stability, now),
      validReason: `Per-test results are kept for ${RETENTION_DAYS.stability} days.`,
      clampDays: CLAMP_DAYS.stability,
    },
    ttrs: { clampDays: CLAMP_DAYS.ttrs },
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

// Each chunk is a grid cell cut to the range; cells that start after now hold
// no data and are not fetched. Beyond MAX_CHUNKS cells the oldest are dropped
// and the range narrows to the cells kept.
export function breakageChunks(
  range: CountedRange,
  now: number = Date.now()
): { chunks: Chunk[]; range: CountedRange } {
  if (range.params === undefined) {
    return { chunks: [], range };
  }
  const anchor = dayStart(JOB_NAMES_VALID_FROM);
  const cell = CHUNK_DAYS * DAY_MS;
  const stopTime = range.params.stopTime;
  const stop = parseUtc(stopTime);
  const last = Math.min(stop, now);
  const cells: [number, number][] = [];
  for (
    let k = Math.floor((range.start - anchor) / cell);
    anchor + k * cell < last;
    k++
  ) {
    cells.push([
      Math.max(range.start, anchor + k * cell),
      Math.min(stop, anchor + (k + 1) * cell),
    ]);
  }
  const kept = cells.slice(-MAX_CHUNKS);
  const narrowed =
    kept.length === cells.length
      ? range
      : {
          ...range,
          params: { startTime: utcText(kept[0][0]), stopTime },
          start: kept[0][0],
          note: readsAtMost(MAX_CHUNKS * CHUNK_DAYS),
        };
  return {
    chunks: kept.map(([from, to]) => ({
      startTime: utcText(from),
      stopTime: utcText(to),
      label: rangeText({ start: from, end: to }),
    })),
    range: narrowed,
  };
}

export interface CiSaved {
  share: number;
  hoursSaved: number;
}

export function ciSaved(row: SavingsRow | undefined): CiSaved | null {
  const pr = num(row?.pr_hours);
  const full = num(row?.est_full_hours);
  if (pr === null || full === null || full === 0) {
    return null;
  }
  return { share: 1 - pr / full, hoursSaved: full - pr };
}

export interface Interval {
  low: number;
  high: number;
}

// Wilson score interval at 95%: stays inside [0, 1] and is not degenerate at
// zero successes, which a normal approximation is with counts this small.
export function wilsonInterval(
  successes: number,
  trials: number
): Interval | null {
  if (trials <= 0 || successes < 0 || successes > trials) {
    return null;
  }
  const z = 1.96;
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) /
    denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export interface BreakageStats {
  falseGreens: number;
  known: number;
  unknown: number;
  share: number | null;
  interval: Interval | null;
  perThousandLandings: number | null;
  recall: number | null;
  recallBase: number;
  ranOnPr: number;
  tdSkippedAny: number;
}

export function breakageStats(row: BreakageRow | undefined): BreakageStats {
  const count = (key: keyof BreakageRow) => num(row?.[key]) ?? 0;
  const falseGreens = count("false_green");
  const unknown = count("unknown");
  const known = Math.max(0, count("events") - unknown);
  const ranOnPr = count("signal_on_pr") + count("passed_on_pr");
  const recallBase = ranOnPr + falseGreens;
  const perLanding = ratio(falseGreens, row?.landed_prs);
  return {
    falseGreens,
    known,
    unknown,
    share: ratio(falseGreens, known),
    interval: wilsonInterval(falseGreens, known),
    perThousandLandings: perLanding === null ? null : perLanding * 1000,
    recall: ratio(ranOnPr, recallBase),
    recallBase,
    ranOnPr,
    tdSkippedAny: count("td_skipped_any"),
  };
}

export interface CurvePoint {
  pct: number;
  share: number;
}

// Point x is the share of landings whose best-ranked new failure sits in the
// top x% of TD's list, so the curve starts at (0, 0) and reaches (100, 1).
export function recallCurve(rows: RankRow[]): CurvePoint[] {
  const perBucket = new Array(100).fill(0);
  for (const row of rows) {
    if (row.grain !== "hist") {
      continue;
    }
    const bucket = num(row.bucket_pct);
    const landings = num(row.landings);
    if (bucket === null || landings === null || bucket < 0 || bucket > 99) {
      continue;
    }
    perBucket[Math.floor(bucket)] += landings;
  }
  const total = perBucket.reduce((sum, n) => sum + n, 0);
  if (total === 0) {
    return [];
  }
  const points: CurvePoint[] = [{ pct: 0, share: 0 }];
  let running = 0;
  perBucket.forEach((landings, bucket) => {
    running += landings;
    points.push({ pct: bucket + 1, share: running / total });
  });
  return points;
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

export function prUrl(prNumber: unknown): string | undefined {
  const n = num(prNumber);
  return n !== null && Number.isInteger(n) && n > 0
    ? `${PYTORCH_REPO_URL}/pull/${n}`
    : undefined;
}

export function commitUrl(sha: unknown): string | undefined {
  return typeof sha === "string" && /^[0-9a-f]{7,40}$/.test(sha)
    ? `${PYTORCH_REPO_URL}/commit/${sha}`
    : undefined;
}

// The window is snapped to whole UTC days, and these queries are too heavy to
// re-run on focus, on reconnect or after a failure.
const TD_SWR_CONFIG = {
  revalidateIfStale: false,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  shouldRetryOnError: false,
};

// No window, nothing to read: an empty counted range or an unused chunk slot.
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
