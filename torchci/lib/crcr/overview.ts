import type { L3SummaryRow } from "lib/crcr/l3Readiness";

export interface CiMetricsRow {
  repo: string;
  downstream_repo_level: string;
  successes: number;
  failures: number;
  timed_out: number;
  total: number;
  pass_rate: number;
  avg_duration_s: number;
  last_run: string;
}

export interface NightlyMetricsRow extends CiMetricsRow {
  latest_sha: string;
}

export interface HealthPrRow {
  pr_number: number;
  last_run: string;
  successes: number;
  total: number;
  pending: number;
  overdue_in_progress: number;
  pass_rate: number | null;
}

export interface NightlyHealthJobRow {
  pytorch_head_sha: string;
  job_name: string;
  status: string;
  conclusion: string;
  started_at: string;
  completed_at: string | null;
  workflow_run_url: string | null;
  check_run_id: string | null;
}

export interface RepoTenureSummaryRow {
  repo: string;
  l2_since: string;
}

export type CrcrOverviewSection =
  | "prSummary"
  | "nightlySummary"
  | "prHealth"
  | "nightlyHealth"
  | "promotionReadiness"
  | "demotionReadiness"
  | "tenure";

export interface CrcrOverviewData {
  prSummary: CiMetricsRow[];
  nightlySummary: NightlyMetricsRow[];
  prHealth: HealthPrRow[];
  nightlyHealth: NightlyHealthJobRow[];
  promotionReadiness: L3SummaryRow[];
  demotionReadiness: L3SummaryRow[];
  tenure: RepoTenureSummaryRow[];
}

export interface CrcrOverviewResponse {
  data: CrcrOverviewData;
  errors: Partial<Record<CrcrOverviewSection, string>>;
}
