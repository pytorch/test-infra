// Query names, constants and formulas behind the Target Determinator page.

import { useClickHouseAPI } from "lib/GeneralUtils";
import type {
  BreakageRow,
  RankRow,
  SavingsRow,
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

// The widest window each query reads; the SQL clamps to the same widths.
export const HORIZON_DAYS = {
  savings: 90,
  breakages: 90,
  ranks: 90,
  stability: 14,
};

// How long the source data is kept: older windows have nothing left to read.
export const RETENTION_DAYS = {
  ranks: 90,
  stability: 30,
};

const DAY_MS = 86400000;

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

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function ratio(numerator: unknown, denominator: unknown): number | null {
  const n = num(numerator);
  const d = num(denominator);
  if (n === null || d === null || d === 0) {
    return null;
  }
  return n / d;
}

function parseUtc(time: string): number {
  return Date.parse(`${time}Z`);
}

export function windowDays(startTime: string, stopTime: string): number {
  return (parseUtc(stopTime) - parseUtc(startTime)) / DAY_MS;
}

// The start a query clamped to `days` before the stop actually reads.
export function clampedStart(params: TdParams, days: number): string {
  const floor = new Date(parseUtc(params.stopTime) - days * DAY_MS);
  const clamped = floor.toISOString().replace("Z", "");
  return clamped > params.startTime ? clamped : params.startTime;
}

export interface Expiry {
  text: string;
  whole: boolean;
}

// The queries read at most `horizonDays` back from min(stop, now), so only
// that span is compared with what the source still keeps.
export function dataExpiry(
  params: TdParams,
  horizonDays: number,
  retentionDays: number,
  now: number = Date.now()
): Expiry | undefined {
  const cutoff = now - retentionDays * DAY_MS;
  const stop = Math.min(parseUtc(params.stopTime), now);
  if (stop <= cutoff) {
    return {
      text: `The data for this window has expired: it is kept for ${retentionDays} days.`,
      whole: true,
    };
  }
  const start = Math.max(
    parseUtc(params.startTime),
    stop - horizonDays * DAY_MS
  );
  return start < cutoff
    ? {
        text: `The data is kept for ${retentionDays} days, so the older part of the window has expired.`,
        whole: false,
      }
    : undefined;
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

export function totalRow<T extends { grain: string }>(
  rows: T[]
): T | undefined {
  return rows.find((row) => row.grain === "total");
}

// A query that answers without its total row broke its contract; saying so
// beats rendering every tile as an empty window.
export function totalError(
  queryName: string,
  state: { loading: boolean; error?: string },
  total: unknown
): string | undefined {
  if (state.error !== undefined) {
    return state.error;
  }
  return !state.loading && total === undefined
    ? `${queryName}: no total row`
    : undefined;
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

export interface TdQueryState<T> {
  loading: boolean;
  error?: string;
  rows: T[];
}

export function readTdQuery<T>(
  queryName: string,
  data: unknown,
  error: any
): TdQueryState<T> {
  if (error !== undefined && error !== null) {
    return {
      loading: false,
      error: `${queryName}: ${error?.message ?? String(error)}`,
      rows: [],
    };
  }
  if (data === undefined) {
    return { loading: true, rows: [] };
  }
  if (!Array.isArray(data)) {
    return {
      loading: false,
      error: `${queryName}: unexpected query response`,
      rows: [],
    };
  }
  return { loading: false, rows: data as T[] };
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
  params: Record<string, unknown>
): TdQueryState<T> {
  const { data, error } = useClickHouseAPI<T>(
    queryName,
    params,
    true,
    TD_SWR_CONFIG
  );
  return readTdQuery<T>(queryName, data, error);
}
