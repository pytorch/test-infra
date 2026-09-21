import { durationDisplay } from "components/common/TimeUtils";
import { fetcherHandleError } from "lib/GeneralUtils";
import { evaluateL3Threshold, L3_THRESHOLDS } from "lib/crcr/l3Thresholds";
import { useMemo } from "react";
import useSWR from "swr";

// Shared between the per-repo CrcrL3Readiness panel and the /crcr
// at-a-glance readiness column so both compute the same verdict off the
// same shared thresholds.

// Shape shared by crcr_backend_summary (single repo, filtered server-side)
// and crcr_l3_summary (all repos, grouped) — the fields buildCriteriaRows
// et al. actually read. crcr_l3_summary rows additionally carry `repo` to
// tell them apart (see L3SummaryRow below); a single-repo query has no
// need for that since the filter already picked the one row.
export interface L3Metrics {
  successes: number;
  timed_out: number;
  total_jobs: number;
  pass_rate: number;
  avg_queue_time_s: number | null;
  max_exec_time_s: number | null;
  overrun_rate: number;
  median_e2e_time_s: number | null;
  timeout_rate: number;
}

// crcr_l3_summary's output — one row per repo, for views that need every
// repo at once (the /crcr at-a-glance readiness column). The per-repo
// panel should prefer the repo-filtered crcr_backend_summary instead of
// fetching this and discarding all but one row.
export interface L3SummaryRow extends L3Metrics {
  repo: string;
}

// Shape of the crcr_repo_tenure query's output.
export interface RepoTenure {
  current_level: string;
  level_since: string;
  l2_since: string;
  first_seen: string;
  last_seen: string;
}

export interface TenureInfo {
  tenureDays: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// "Time at L2" is cumulative from when the repo first reached L2, not reset
// by later promotions.
export function tenureInfoFromRow(
  row: RepoTenure | null | undefined
): TenureInfo | null {
  if (!row) return null;
  const l2Since = new Date(row.l2_since).getTime();
  if (!(l2Since > 0)) return null;
  return { tenureDays: (Date.now() - l2Since) / MS_PER_DAY };
}

// Same crcr_repo_tenure query + params used by the per-repo panel, the
// at-a-glance readiness column, and the page header's own "L2 since ..."
// text — SWR dedupes the identical key across all of them, so sharing this
// hook doesn't add extra requests.
export function useTenure(repoFullName: string) {
  const url = `/api/clickhouse/crcr_repo_tenure?parameters=${encodeURIComponent(
    JSON.stringify({ repo: repoFullName })
  )}`;
  const { data, error } = useSWR<RepoTenure[]>(url, fetcherHandleError, {
    refreshInterval: 60_000,
  });
  const tenure = useMemo(() => tenureInfoFromRow(data?.[0]), [data]);
  return { tenure, loaded: !!data || !!error };
}

// crcr_l3_summary keyed by repo, for views that judge every repo at once.
// `days` is the fixed L3 evaluation window the caller is judging over, never
// a user-facing Time Range selector.
export function useL3SummaryMap(days: number) {
  const url =
    `/api/clickhouse/crcr_l3_summary?parameters=` +
    encodeURIComponent(JSON.stringify({ days: String(days) }));
  const { data, error } = useSWR<L3SummaryRow[]>(url, fetcherHandleError, {
    refreshInterval: 60_000,
  });
  const map = useMemo(() => {
    const byRepo = new Map<string, L3SummaryRow>();
    for (const row of data ?? []) {
      byRepo.set(row.repo, row);
    }
    return byRepo;
  }, [data]);
  return { map, loaded: !!data || !!error, error };
}

export type L3MeasuredFormat = "days" | "duration" | "percent";

export interface CriterionRow {
  key: string;
  criterion: string;
  measured: number | null;
  format: L3MeasuredFormat;
  targetLabel: string;
  verdict: boolean | null;
  provisional: boolean;
}

/** Renders a row's measured value in the unit its criterion is judged in. */
export function formatMeasured(row: CriterionRow): string {
  if (row.measured == null) return "–";
  switch (row.format) {
    case "days":
      return `${row.measured.toFixed(0)} days`;
    case "duration":
      return durationDisplay(Math.round(row.measured));
    case "percent":
      return `${(row.measured * 100).toFixed(1)}%`;
  }
}

function buildRow(
  threshold: (typeof L3_THRESHOLDS)[keyof typeof L3_THRESHOLDS],
  measured: number | null,
  format: L3MeasuredFormat
): CriterionRow {
  return {
    key: threshold.key,
    criterion: threshold.label,
    measured,
    format,
    targetLabel: threshold.targetLabel,
    verdict: evaluateL3Threshold(threshold, measured),
    provisional: threshold.provisional,
  };
}

// The five summary-derived metrics (everything but tenure).
const METRICS: {
  threshold: (typeof L3_THRESHOLDS)[keyof typeof L3_THRESHOLDS];
  format: L3MeasuredFormat;
  getMeasured: (summary: L3Metrics | null) => number | null;
}[] = [
  {
    threshold: L3_THRESHOLDS.e2eTimeS,
    format: "duration",
    getMeasured: (s) => s?.median_e2e_time_s ?? null,
  },
  {
    threshold: L3_THRESHOLDS.overrunRate,
    format: "percent",
    getMeasured: (s) => (s ? s.overrun_rate : null),
  },
  {
    threshold: L3_THRESHOLDS.avgQueueTimeS,
    format: "duration",
    getMeasured: (s) => s?.avg_queue_time_s ?? null,
  },
  {
    threshold: L3_THRESHOLDS.timeoutRate,
    format: "percent",
    getMeasured: (s) => (s ? s.timeout_rate : null),
  },
  {
    threshold: L3_THRESHOLDS.passRate,
    format: "percent",
    getMeasured: (s) => (s ? s.pass_rate : null),
  },
];

// L3 Promotion — tenure + five metrics, evaluated over the 2-week
// promotion window (L3_PROMOTION_WINDOW_DAYS).
export function buildCriteriaRows(
  summary: L3Metrics | null,
  tenure: TenureInfo | null
): CriterionRow[] {
  return [
    buildRow(L3_THRESHOLDS.tenureAtL2Days, tenure?.tenureDays ?? null, "days"),
    ...METRICS.map((m) =>
      buildRow(m.threshold, m.getMeasured(summary), m.format)
    ),
  ];
}

// L3 Demotion — the subset of metrics flagged `demotionRelevant` (no
// tenure, no max exec/avg queue), evaluated over the 1-week demotion
// window.
export function buildDemotionRows(summary: L3Metrics | null): CriterionRow[] {
  return METRICS.filter((m) => m.threshold.demotionRelevant).map((m) =>
    buildRow(m.threshold, m.getMeasured(summary), m.format)
  );
}

// One row per criterion, promotion and demotion verdicts side by side —
// demotion is a subset of promotion's criteria, so `demotion` is null for
// rows that aren't part of the demotion trigger list.
export interface MergedCriterionRow {
  key: string;
  criterion: string;
  targetLabel: string;
  provisional: boolean;
  promotion: CriterionRow;
  demotion: CriterionRow | null;
}

export function mergeCriteriaRows(
  promotionRows: CriterionRow[],
  demotionRows: CriterionRow[]
): MergedCriterionRow[] {
  const demotionByKey = new Map(demotionRows.map((r) => [r.key, r]));
  return promotionRows.map((p) => ({
    key: p.key,
    criterion: p.criterion,
    targetLabel: p.targetLabel,
    provisional: p.provisional,
    promotion: p,
    demotion: demotionByKey.get(p.key) ?? null,
  }));
}

export interface ReadinessSummary {
  judgedCount: number;
  metCount: number;
  totalCount: number;
  ready: boolean;
}

export function summarizeReadiness(rows: CriterionRow[]): ReadinessSummary {
  const judged = rows.filter((r) => r.verdict != null);
  const met = judged.filter((r) => r.verdict).length;
  return {
    judgedCount: judged.length,
    metCount: met,
    totalCount: rows.length,
    ready: judged.length > 0 && met === rows.length,
  };
}
