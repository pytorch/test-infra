// The TD scorer's daily refit as the td_scorer_refits query returns it, and
// the live model pytorch reads from generated-stats.

import { fetcherCatchErrorStatus } from "lib/GeneralUtils";
import { parseStamp } from "lib/greenlight/qualityFigures";
import { DAY_MS, dayStart } from "lib/targetDeterminator";
import { type ChNum, num } from "lib/targetDeterminatorRows";

// Statuses and conclusions are '' for a job the run has no row for.
export interface RefitRow {
  run_id: string;
  run_attempt: ChNum;
  created_at: string;
  run_status: string;
  run_conclusion: string;
  refit_status: string;
  refit_conclusion: string;
  refit_minutes: ChNum;
  refit_failed_step: string;
  check_status: string;
  check_conclusion: string;
  publish_status: string;
  publish_conclusion: string;
  report_attempt: ChNum;
  report_infos: ChNum;
  report_valid: ChNum;
  passed: ChNum;
  floor_ok: ChNum;
  floor_ratio: ChNum;
  budget_on: ChNum;
  budget_retention: ChNum;
  budget_retention_floor: ChNum;
  budget_ok: ChNum;
  budget_seconds_share: ChNum;
  holdout_events: ChNum;
  holdout_td_caught: ChNum;
  holdout_scorer_caught: ChNum;
  holdout_healthy: ChNum;
  days_training: ChNum;
  days_gaps: ChNum;
  days_unhealthy: ChNum;
  days_missing: ChNum;
  total_ratio: ChNum;
  wf_month: string[];
  wf_prs: ChNum[];
  wf_ratio: ChNum[];
  wf_event_recall: ChNum[];
  wf_trunk_landings: ChNum[];
  wf_trunk_caught: ChNum[];
  wf_risk_auc: ChNum[];
}

export type RefitOutcome =
  | "running"
  | "cancelled"
  | "refit_failed"
  | "gate_failed"
  | "check_failed"
  | "not_validated"
  | "publish_failed"
  | "published"
  | "unknown";

export const OUTCOME_TEXT: Record<RefitOutcome, string> = {
  running: "Running",
  cancelled: "Cancelled",
  refit_failed: "Refit failed",
  gate_failed: "Gate failed",
  check_failed: "Check failed",
  not_validated: "Not validated by pytorch",
  publish_failed: "Publish failed",
  published: "Published",
  unknown: "Unknown",
};

const FAILED = new Set(["failure", "timed_out"]);

// From the jobs alone; the report only tells a failed gate from another
// failure of the refit job.
export function refitOutcome(row: RefitRow): RefitOutcome {
  if (row.run_status !== "completed") {
    return "running";
  }
  const refit = row.refit_conclusion;
  if (refit === "") {
    return row.run_conclusion === "cancelled" ? "cancelled" : "unknown";
  }
  if (refit === "cancelled") {
    return "cancelled";
  }
  if (FAILED.has(refit)) {
    return num(row.passed) === 0 ? "gate_failed" : "refit_failed";
  }
  if (refit !== "success") {
    return "unknown";
  }
  const check = row.check_conclusion;
  if (check === "cancelled") {
    return "cancelled";
  }
  if (FAILED.has(check)) {
    return "check_failed";
  }
  if (check !== "success") {
    return "unknown";
  }
  const publish = row.publish_conclusion;
  return publish === "skipped"
    ? "not_validated"
    : publish === "cancelled"
    ? "cancelled"
    : FAILED.has(publish)
    ? "publish_failed"
    : publish === "success"
    ? "published"
    : "unknown";
}

export type ReportState =
  | "present"
  | "pending"
  | "missing"
  | "conflicting"
  | "invalid";

export const REPORT_TEXT: Record<ReportState, string> = {
  present: "Uploaded",
  pending: "Not yet uploaded",
  missing: "Missing",
  conflicting: "Conflicting rows",
  invalid: "Not valid JSON",
};

export const REPORT_PENDING_HOURS = 6;

export function reportState(row: RefitRow, now: number): ReportState {
  if ((num(row.report_attempt) ?? 0) > 0) {
    return (num(row.report_infos) ?? 0) > 1
      ? "conflicting"
      : num(row.report_valid) === 1
      ? "present"
      : "invalid";
  }
  const created = parseStamp(row.created_at)?.valueOf();
  const recent =
    created !== undefined && now - created < REPORT_PENDING_HOURS * 3600000;
  return row.run_status !== "completed" || recent ? "pending" : "missing";
}

// The rows are newest first; figures come only from a report that is present.
export function latestReport(
  rows: RefitRow[],
  now: number
): RefitRow | undefined {
  return rows.find((row) => reportState(row, now) === "present");
}

export interface RefitMonth {
  month: string;
  start: number;
  partial: boolean;
  prs: number | null;
  ratio: number | null;
  eventRecall: number | null;
  riskAuc: number | null;
  trunkLandings: number | null;
  trunkCaught: number | null;
}

const MONTH = /^\d{4}-\d{2}$/;

// A month is partial from the UTC month the run was created in on: the refit
// evaluated only its first days.
export function reportMonths(row: RefitRow): RefitMonth[] {
  const runMonth = parseStamp(row.created_at)?.format("YYYY-MM") ?? "";
  const months = Array.isArray(row.wf_month) ? row.wf_month : [];
  const at = (values: ChNum[] | undefined, i: number) =>
    num(Array.isArray(values) ? values[i] : null);
  return months.flatMap((month, i) =>
    typeof month === "string" && MONTH.test(month)
      ? [
          {
            month,
            start: dayStart(`${month}-01`),
            partial: month >= runMonth,
            prs: at(row.wf_prs, i),
            ratio: at(row.wf_ratio, i),
            eventRecall: at(row.wf_event_recall, i),
            riskAuc: at(row.wf_risk_auc, i),
            trunkLandings: at(row.wf_trunk_landings, i),
            trunkCaught: at(row.wf_trunk_caught, i),
          },
        ]
      : []
  );
}

export function lastCompleteMonth(
  months: RefitMonth[]
): RefitMonth | undefined {
  return months.filter((m) => !m.partial).pop();
}

const RUN_ID = /^\d+$/;

export function runUrl(runId: unknown): string | undefined {
  return typeof runId === "string" && RUN_ID.test(runId)
    ? `https://github.com/pytorch/test-infra/actions/runs/${runId}`
    : undefined;
}

export const LIVE_MODEL_URLS = {
  plain:
    "https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/td-scorer.json",
  budget:
    "https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/td-scorer-budget.json",
};

// pytorch's limits (tools/testing/target_determination/scorer.py
// MAX_MODEL_AGE_DAYS and BUDGET_STALE_DAYS).
export const MODEL_MAX_AGE_DAYS = 7;
export const BUDGET_MAX_AGE_DAYS = 3;

export type BudgetState =
  | "live"
  | "off"
  | "stale"
  | "mismatch"
  | "unusable"
  | "unknown";

export type LiveModel =
  | { state: "loading" }
  | { state: "unknown" }
  | { state: "disabled"; version: string }
  | { state: "stale"; version: string; ageDays: number | null }
  | {
      state: "usable";
      version: string;
      ageDays: number;
      budget: BudgetState;
    };

const FETCH_FAILED = Symbol("fetch failed");

interface ModelFile {
  enabled: boolean;
  version: string;
  hasBudget: boolean;
}

function readModelFile(json: unknown): ModelFile | undefined {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return undefined;
  }
  const { enabled, version } = json as Record<string, unknown>;
  return typeof enabled === "boolean" && typeof version === "string"
    ? { enabled, version, hasBudget: "budget" in json }
    : undefined;
}

// Whole UTC days from the version's date to now's; null when the version is
// not an ISO date.
export function modelAgeDays(version: string, now: number): number | null {
  const start = dayStart(version);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(version) ||
    !Number.isFinite(start) ||
    new Date(start).toISOString().slice(0, 10) !== version
  ) {
    return null;
  }
  return Math.floor((now - start) / DAY_MS);
}

function usableAge(age: number | null, maxDays: number): age is number {
  return age !== null && age >= -1 && age <= maxDays;
}

// Mirrors pytorch's rules: scorer.py _is_stale on each file, and
// do_target_determination_for_s3.py choose_scorer_block for the budget.
// Anything unreadable fails closed: never usable, never a live budget.
export function liveModel(
  plain: unknown,
  budget: unknown,
  now: number
): LiveModel {
  const model = plain === FETCH_FAILED ? undefined : readModelFile(plain);
  if (model === undefined) {
    return { state: "unknown" };
  }
  if (!model.enabled) {
    return { state: "disabled", version: model.version };
  }
  const ageDays = modelAgeDays(model.version, now);
  if (!usableAge(ageDays, MODEL_MAX_AGE_DAYS)) {
    return { state: "stale", version: model.version, ageDays };
  }
  const file = budget === FETCH_FAILED ? undefined : readModelFile(budget);
  const fileAge = file === undefined ? null : modelAgeDays(file.version, now);
  const budgetState: BudgetState =
    file === undefined
      ? "unknown"
      : !file.enabled || !usableAge(fileAge, MODEL_MAX_AGE_DAYS)
      ? "unusable"
      : file.version !== model.version
      ? "mismatch"
      : !file.hasBudget
      ? "off"
      : !usableAge(fileAge, BUDGET_MAX_AGE_DAYS)
      ? "stale"
      : "live";
  return {
    state: "usable",
    version: model.version,
    ageDays,
    budget: budgetState,
  };
}

// Never rejects: a file that cannot be fetched or parsed reads as unknown.
export async function readLiveModel(now: number): Promise<LiveModel> {
  const [plain, budget] = await Promise.allSettled([
    fetcherCatchErrorStatus(LIVE_MODEL_URLS.plain),
    fetcherCatchErrorStatus(LIVE_MODEL_URLS.budget),
  ]);
  const value = (result: PromiseSettledResult<unknown>) =>
    result.status === "fulfilled" ? result.value : FETCH_FAILED;
  return liveModel(value(plain), value(budget), now);
}
