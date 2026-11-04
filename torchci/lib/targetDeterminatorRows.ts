// Rows the td_* queries return, as pinned by their column contracts, and how
// the page reads them.

// ClickHouse serialises 64-bit integers as JSON strings.
export type ChNum = number | string | null;

// Day and week buckets are UTC dates, a week's being its ISO Monday.
export interface SavingsRow {
  grain: "day" | "week" | "config" | "total";
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
  grain: "day" | "week" | "total";
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
  | "signal_on_pr"
  | "passed_on_pr"
  | "new_test"
  | "not_in_pr_matrix"
  | "landrace"
  | "unknown";

export type TestOutcome =
  | "failed_on_pr"
  | "passed_on_pr"
  | "td_skipped"
  | "new_test"
  | "config_not_on_pr"
  | "unknown"
  | "not_checked";

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
  breaking_tests: ChNum;
  test_configs: string[];
  test_files: string[];
  test_prs: ChNum[];
  test_outcomes: TestOutcome[];
  landed_prs: ChNum;
  events: ChNum;
  false_green: ChNum;
  signal_on_pr: ChNum;
  passed_on_pr: ChNum;
  td_skipped_any: ChNum;
  new_test: ChNum;
  not_in_pr_matrix: ChNum;
  landrace: ChNum;
  unknown: ChNum;
  other_reverts: ChNum;
  ghfirst_reverts: ChNum;
}

// A landing row is one trunk breakage, newest first, with its best-ranked
// failure; inside_cut and second_half are 0 or 1 on it.
export interface RankRow {
  grain: "hist" | "total" | "landing";
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
  grain: "day" | "week" | "total";
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
  signal_on_pr: "Test failed on the PR, merged anyway",
  passed_on_pr: "Test ran and passed on the PR",
  new_test: "Test newer than the PR",
  not_in_pr_matrix: "Job not run on the PR",
  landrace: "Landrace",
  unknown: "Unknown",
};

export const TEST_OUTCOME_LABELS: Record<TestOutcome, string> = {
  failed_on_pr: "failed on the PR",
  passed_on_pr: "passed on the PR",
  td_skipped: "skipped by TD",
  new_test: "newer than the PR",
  config_not_on_pr: "job not run on the PR",
  unknown: "unknown",
  not_checked: "not checked",
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

export interface TdQueryState<T> {
  loading: boolean;
  error?: string;
  rows: T[];
}

export interface TdTotalState<T> extends TdQueryState<T> {
  total?: T;
  tileError?: string;
}

// A query that is not enabled reads nothing, so it is not loading either.
export function readTdQuery<T>(
  queryName: string,
  data: unknown,
  error: any,
  enabled: boolean = true
): TdQueryState<T> {
  if (!enabled) {
    return { loading: false, rows: [] };
  }
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

export interface Chunk {
  startTime: string;
  stopTime: string;
  label: string;
}

const BREAKAGE_COUNTS = [
  "landed_prs",
  "events",
  "false_green",
  "signal_on_pr",
  "passed_on_pr",
  "td_skipped_any",
  "new_test",
  "not_in_pr_matrix",
  "landrace",
  "unknown",
  "other_reverts",
  "ghfirst_reverts",
] as const;

// One failed or malformed chunk fails the whole section: a sum over the chunks
// that answered would pass for the window's total.
export function mergeBreakageChunks(
  queryName: string,
  chunks: Chunk[],
  states: TdQueryState<BreakageRow>[]
): TdTotalState<BreakageRow> {
  const failed = (error: string) => ({
    loading: false,
    error,
    tileError: error,
    rows: [],
  });
  if (states.length < chunks.length) {
    return failed(`${queryName}: more chunks than query slots`);
  }
  const answered = chunks.map((chunk, i) => ({ chunk, state: states[i] }));
  const error = answered.find(({ state }) => state.error !== undefined);
  if (error !== undefined) {
    return failed(`${error.state.error} (${error.chunk.label})`);
  }
  if (answered.some(({ state }) => state.loading)) {
    return { loading: true, rows: [] };
  }
  const totals: BreakageRow[] = [];
  for (const { chunk, state } of answered) {
    const found = state.rows.filter((row) => row.grain === "total");
    if (found.length !== 1) {
      return failed(
        `${queryName} (${chunk.label}): ${found.length} total rows, expected 1`
      );
    }
    totals.push(found[0]);
  }
  const total =
    totals.length === 0
      ? undefined
      : totals.reduce((sum, row) => {
          const next = { ...sum };
          for (const key of BREAKAGE_COUNTS) {
            next[key] = (num(sum[key]) ?? 0) + (num(row[key]) ?? 0);
          }
          return next;
        });
  return {
    loading: false,
    rows: answered.flatMap(({ state }) =>
      state.rows.filter((row) => row.grain === "event")
    ),
    total,
  };
}
