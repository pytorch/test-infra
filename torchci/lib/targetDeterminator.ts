// Query names, constants and formulas behind the Target Determinator page.

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

// Before these UTC days a section's data does not measure what it claims.
// Test jobs ran as "<build> / test-osdc (...)" until 2026-07-12, which the
// savings baseline cannot match to the same job on main.
export const SAVINGS_VALID_FROM = "2026-07-13";
// The new-test check reads 14 days of tests.all_test_runs_by_name, which starts
// on 2026-08-26; before then new tests count as false greens.
export const BREAKAGES_VALID_FROM = "2026-09-09";

// The widest window each query reads; the SQL clamps to the same widths.
// ttrs_percentiles has no clamp or execution cap of its own and reads tens of
// GB per month, so the page keeps it to the last 30 days of the window.
export const CLAMP_DAYS = {
  savings: 365,
  pushWait: 365,
  breakages: 90,
  ranks: 90,
  churn: 30,
  ttrs: 30,
};

// td_trunk_breakages reads at most CLAMP_DAYS.breakages, so longer windows are
// fetched in chunks of that size, on a grid fixed at BREAKAGES_VALID_FROM so a
// chunk whose revert windows have closed keeps its SWR key and its answer.
export const CHUNK_DAYS = CLAMP_DAYS.breakages;
export const MAX_CHUNKS = 6;

// How long the source data is kept: older windows have nothing left to read.
export const RETENTION_DAYS = {
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

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export interface RangeLimit {
  validFrom?: number;
  validReason?: string;
  clampDays?: number;
}

// The part of the picked window a section counts. startTime and stopTime are
// the query's parameters: the stop stays the picked one, so the SWR key does
// not move with the clock. end is where data stops, min(stop, now).
export interface CountedRange {
  startTime: string;
  stopTime: string;
  start: number;
  end: number;
  empty: boolean;
  note?: string;
}

// Whole UTC days, so the first counted day is kept in full and the key changes
// once a day.
function retainedFrom(days: number, now: number): number {
  return dayStart(utcDay(now)) - (days - 1) * DAY_MS;
}

export function sectionLimits(now: number = Date.now()) {
  return {
    savings: {
      validFrom: dayStart(SAVINGS_VALID_FROM),
      validReason: `Test jobs had other names before ${SAVINGS_VALID_FROM}, so earlier PR jobs cannot be matched with main.`,
      clampDays: CLAMP_DAYS.savings,
    },
    breakages: {
      validFrom: dayStart(BREAKAGES_VALID_FROM),
      validReason: `Before ${BREAKAGES_VALID_FROM} there is too little test history to tell new tests from skipped ones.`,
    },
    ranks: {
      validFrom: retainedFrom(RETENTION_DAYS.ranks, now),
      validReason: `TD's rankings are kept for ${RETENTION_DAYS.ranks} days.`,
      clampDays: CLAMP_DAYS.ranks,
    },
    stability: {
      validFrom: retainedFrom(RETENTION_DAYS.stability, now),
      validReason: `Per-test results are kept for ${RETENTION_DAYS.stability} days.`,
      clampDays: CLAMP_DAYS.churn,
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
  const clampFrom =
    limit.clampDays === undefined ? -Infinity : stop - limit.clampDays * DAY_MS;
  const start = Math.max(picked, validFrom, clampFrom);
  const end = Math.min(stop, now);
  return {
    startTime: utcText(start),
    stopTime: params.stopTime,
    start,
    end,
    empty: !(start < end),
    note:
      start <= picked
        ? undefined
        : validFrom >= clampFrom
        ? limit.validReason
        : `This section reads at most ${limit.clampDays} days at a time.`,
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
  if (range.empty) {
    return { chunks: [], range };
  }
  const anchor = dayStart(BREAKAGES_VALID_FROM);
  const cell = CHUNK_DAYS * DAY_MS;
  const stop = parseUtc(range.stopTime);
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
          start: kept[0][0],
          startTime: utcText(kept[0][0]),
          note: `This section reads at most ${
            MAX_CHUNKS * CHUNK_DAYS
          } days at a time.`,
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

export function useTdQuery<T>(
  queryName: string,
  params: Record<string, unknown>,
  enabled: boolean = true
): TdQueryState<T> {
  const { data, error } = useClickHouseAPI<T>(
    queryName,
    params,
    enabled,
    TD_SWR_CONFIG
  );
  return readTdQuery<T>(queryName, data, error);
}
