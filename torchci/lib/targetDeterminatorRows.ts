// Rows the td_* queries return, as pinned by their column contracts.

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
