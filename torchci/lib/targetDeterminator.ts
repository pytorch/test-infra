// Queries, row types and formulas behind the Target Determinator page.

import { fetcherHandleError } from "lib/GeneralUtils";
import useSWRImmutable from "swr/immutable";

// Where TD is on. Passed to every td_* query as Array(String) params, so the
// page and the SQL can never disagree on the population.
export const TD_SCOPE = {
  tdWorkflows: ["pull", "trunk"],
  tdWorkflowPrefixes: ["rocm-", "periodic-rocm-"],
  noTdBuildMarkers: ["macos", "xpu", "onnx"],
};

export const REVERT_WINDOW_DAYS = 7;
export const NEW_TEST_DAYS = 14;
export const TD_CUT_PCT = 25;

// The widest window each query reads; the SQL clamps to the same widths.
export const HORIZON_DAYS = {
  savings: 90,
  breakages: 90,
  ranks: 90,
  stability: 14,
};

export const TD_QUERIES = {
  savings: "td_ci_savings",
  pushWait: "td_push_wait",
  breakages: "td_trunk_breakages",
  ranks: "td_failure_ranks",
  churn: "td_selection_churn",
  ttrs: "ttrs_percentiles",
};

export const PYTORCH_REPO_URL = "https://github.com/pytorch/pytorch";

// ClickHouse serialises 64-bit integers as JSON strings.
export type ChNum = number | string | null;

export interface SavingsRow {
  grain: "day" | "config" | "total";
  bucket: string;
  config: string;
  jobs: ChNum;
  unmatched_jobs: ChNum;
  pr_hours: ChNum;
  est_full_hours: ChNum;
  pr_median_min: ChNum;
  full_median_min: ChNum;
}

export interface PushWaitRow {
  grain: "day" | "total";
  bucket: string;
  pushes: ChNum;
  actual_ttg_median_min: ChNum;
  est_ttg_median_min: ChNum;
  saved_median_min: ChNum;
  hours_per_push: ChNum;
  est_hours_per_push: ChNum;
}

export type BreakageOutcome =
  | "false_green"
  | "caught_on_pr"
  | "new_test"
  | "not_in_pr_matrix"
  | "landrace"
  | "unknown";

export type TestOutcome =
  | "ran_on_pr"
  | "td_skipped"
  | "new_test"
  | "config_not_on_pr"
  | "unknown";

export interface BreakageRow {
  grain: "event" | "total";
  landed_at: string;
  landing_sha: string;
  reverted_prs: ChNum[];
  revert_shas: string[];
  reverted_at: string;
  revert_class: string;
  stack_size: ChNum;
  outcome: BreakageOutcome;
  window_closed: ChNum;
  test_configs: string[];
  test_files: string[];
  test_prs: ChNum[];
  test_outcomes: TestOutcome[];
  landed_prs: ChNum;
  events: ChNum;
  false_green: ChNum;
  caught_on_pr: ChNum;
  new_test: ChNum;
  not_in_pr_matrix: ChNum;
  landrace: ChNum;
  unknown: ChNum;
  other_reverts: ChNum;
  ghfirst_reverts: ChNum;
}

export interface RankRow {
  grain: "hist" | "total" | "miss";
  bucket_pct: ChNum;
  landings: ChNum;
  failures: ChNum;
  inside_cut: ChNum;
  second_half: ChNum;
  median_pct: ChNum;
  landed_at: string;
  sha: string;
  config: string;
  test_file: string;
  rank_pct: ChNum;
}

export interface ChurnRow {
  grain: "day" | "total";
  bucket: string;
  pairs: ChNum;
  identical_pairs: ChNum;
  changed_median_pct: ChNum;
  prs: ChNum;
}

export interface TtrsRow {
  bucket: string;
  custom: ChNum;
}

export const OUTCOME_LABELS: Record<BreakageOutcome, string> = {
  false_green: "False green (TD skipped the test)",
  caught_on_pr: "Test ran on the PR",
  new_test: "Test newer than the PR",
  not_in_pr_matrix: "Job not run on the PR",
  landrace: "Landrace",
  unknown: "Unknown",
};

export const TEST_OUTCOME_LABELS: Record<TestOutcome, string> = {
  ran_on_pr: "ran on the PR",
  td_skipped: "skipped by TD",
  new_test: "newer than the PR",
  config_not_on_pr: "job not run on the PR",
  unknown: "unknown",
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

export function windowDays(startTime: string, stopTime: string): number {
  return (Date.parse(`${stopTime}Z`) - Date.parse(`${startTime}Z`)) / 86400000;
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
  trials: number,
  z: number = 1.96
): Interval | null {
  if (trials <= 0 || successes < 0 || successes > trials) {
    return null;
  }
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) /
    denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

const KNOWN_OUTCOMES: BreakageOutcome[] = [
  "false_green",
  "caught_on_pr",
  "new_test",
  "not_in_pr_matrix",
  "landrace",
];

export interface BreakageStats {
  falseGreens: number;
  known: number;
  unknown: number;
  share: number | null;
  interval: Interval | null;
  perThousandPrs: number | null;
  recall: number | null;
  recallBase: number;
}

export function breakageStats(row: BreakageRow | undefined): BreakageStats {
  const count = (key: BreakageOutcome) => num(row?.[key]) ?? 0;
  const falseGreens = count("false_green");
  const known = KNOWN_OUTCOMES.reduce((sum, key) => sum + count(key), 0);
  const recallBase =
    count("caught_on_pr") + count("false_green") + count("new_test");
  const perPr = ratio(falseGreens, row?.landed_prs);
  return {
    falseGreens,
    known,
    unknown: count("unknown"),
    share: ratio(falseGreens, known),
    interval: wilsonInterval(falseGreens, known),
    perThousandPrs: perPr === null ? null : perPr * 1000,
    recall: ratio(count("caught_on_pr"), recallBase),
    recallBase,
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

export function shareIdentical(row: ChurnRow | undefined): number | null {
  return ratio(row?.identical_pairs, row?.pairs);
}

export function totalRow<T extends { grain: string }>(
  rows: T[],
  match: (_row: T) => boolean = () => true
): T | undefined {
  return rows.find((row) => row.grain === "total" && match(row));
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

export function fractionText(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
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
    const detail = typeof error?.info === "string" ? ` (${error.info})` : "";
    return {
      loading: false,
      error: `${queryName}: ${error?.message ?? String(error)}${detail}`,
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

export function tdQueryUrl(
  queryName: string,
  params: Record<string, unknown>
): string {
  return `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(params)
  )}`;
}

// Immutable: the window is snapped to whole UTC days, and these queries are
// too heavy to re-run on focus or on a timer.
export function useTdQuery<T>(
  queryName: string,
  params: Record<string, unknown>
): TdQueryState<T> {
  const { data, error } = useSWRImmutable(
    tdQueryUrl(queryName, params),
    fetcherHandleError
  );
  return readTdQuery<T>(queryName, data, error);
}
