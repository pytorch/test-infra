// Fetching the saved ClickHouse queries behind the GreenLight Quality page.

import { LARGE_WINDOW_DAYS } from "components/common/timeWindow";
import { fetcher } from "lib/GeneralUtils";
import { GREENLIGHT_REPOS } from "lib/greenlight/greenlightConfig";
import type { ChartGranularity } from "lib/greenlight/qualityCharts";
import { effectiveWindowDays } from "lib/greenlight/qualityFigures";
import useSWR from "swr";

// The page has no repo picker. GreenLight evaluates a single repo and the
// ledger is keyed by it, so the read-back gate's list is the only source.
export const GREENLIGHT_QUALITY_REPO = GREENLIGHT_REPOS[0];

export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export const QUALITY_QUERIES = {
  coverage: "greenlight_quality_coverage",
  latency: "greenlight_quality_latency",
  mergeAuthority: "greenlight_quality_merge_authority",
  reverts: "greenlight_quality_reverts",
};

// A shadow evaluation is one GreenLight ran without publishing its approving
// review. Every query on this page classifies its units the same way, so the
// three states partition whatever GreenLight evaluated: enforcing + shadow ==
// all there. Totals over every merge or every revert are not split by mode.
export type ShadowMode = "all" | "enforcing" | "shadow";

export const DEFAULT_SHADOW_MODE: ShadowMode = "all";

export interface ShadowModeOption {
  value: ShadowMode;
  label: string;
}

// The values are typed, so a mistyped one is a compile error rather than a
// state the SQL falls open on and reads as "all".
export const SHADOW_MODE_OPTIONS: ShadowModeOption[] = [
  { value: "all", label: "All" },
  { value: "enforcing", label: "Enforcing only" },
  { value: "shadow", label: "Shadow only" },
];

// An absent granularity drops out of the blob, since JSON.stringify omits an
// undefined value, and the query falls back to its params.json default: one
// whole-window row.
export function qualityUrl(
  queryName: string,
  startTime: string,
  stopTime: string,
  shadowMode: ShadowMode,
  granularity?: ChartGranularity
): string {
  return `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify({
      startTime,
      stopTime,
      repo: GREENLIGHT_QUALITY_REPO,
      shadowMode,
      granularity,
    })
  )}`;
}

// The row interfaces are declared for the queries the page reads through
// indirection — tile-config field names, the charts' bucket columns and DataGrid
// column declarations — so a mistyped one is a compile error rather than a
// silent "-". They are NOT the guard against the SQL renaming a column: an
// interface left untouched by that rename still declares the old name and still
// compiles. test/greenlightQualityColumnSync.test.ts is what closes that, by
// parsing the queries themselves, and its reads check is all that covers the
// merge chart's series fields, which are plain strings.

// CoverageRow and MergeAuthorityRow are absent from that test's ROW_INTERFACES,
// on purpose. MIN_FIELDS_PER_INTERFACE is one floor shared by every registered
// interface, so admitting rows this narrow would drop it far enough that most of
// LatencyRow or RevertRow could vanish unnoticed. These rows keep the keyof
// check on the fields typed against them and forgo the SQL-sync one.
export interface CoverageRow {
  coverage_bucket: string;
  prs_evaluated: number;
  prs_with_verdict: number;
  verdicts_total: number;
  verdicts_distinct_pr_sha: number;
  land_verdicts: number;
  no_land_verdicts: number;
  cancelled_failed: number;
  // A PR is placed by its latest verdict inside the window, so these partition
  // prs_with_verdict and not prs_evaluated.
  prs_land: number;
  prs_no_land: number;
  effective_start: string;
  effective_end: string;
}

export interface MergeAuthorityRow {
  merge_bucket: string;
  merged_evaluated_prs: number;
  gl_only: number;
  pct_gl_only: number | null;
  human_approved: number;
  no_approval: number;
  merged_prs_total: number;
  pct_of_all_merges: number | null;
}

export interface LatencyRow {
  latency_bucket: string;
  n_end_to_end: number;
  e2e_p50_s: number | null;
  n_e2e_within_cutoff: number;
  e2e_cutoff_s: number;
  n_review: number;
  n_review_over_threshold: number;
  review_visible_after_s: number;
  n_review_runs: number;
  n_review_runs_failed: number;
  n_review_runs_timed: number;
  n_review_runs_over_runtime: number;
  review_runtime_cutoff_s: number;
  n_dispatch: number;
  dispatch_p50_s: number | null;
  n_dispatch_within_cutoff: number;
  dispatch_cutoff_s: number;
  n_e2e_unanchored: number;
  n_dispatch_unanchored: number;
  excluded_no_push_ts: number;
  excluded_push_after_event: number;
  excluded_pre_ledger: number;
}

export interface RevertRow {
  pr_number: number;
  title: string;
  author: string;
  merged_sha: string;
  // NULL on a revert that resolves to no PR, so no merge exists to point at.
  merged_at: string | null;
  verdict: string;
  // NULL rather than the epoch on a revert GreenLight never evaluated, so the
  // absent case is distinguishable from a real 1970 timestamp.
  verdict_at: string | null;
  // NULL on the anchor row a revert-free window returns, which has no revert to
  // point at. Masked in the projection only: every CTE still compares the raw
  // epoch, which sorts correctly as before-everything.
  reverted_at: string | null;
  revert_sha: string;
  reverter: string;
  revert_classification: string;
  revert_message: string;
  merged_version_approved: string;
  // 0 or 1: whether this row is one of the reverts land_approved_reverts counts.
  counts_in_rate: number;
  resolvable_reverts: number;
  attributable_reverts: number;
  evaluated_reverts: number;
  land_approved_reverts: number;
  land_approved_ghfirst_reverts: number;
  land_approved_stale_reverts: number;
  unattributable_reverts: number;
  ghfirst_reverts: number;
  evaluated_prs_total: number;
}

export interface QualityQueryState {
  loading: boolean;
  error?: string;
  rows: any[];
  row?: any;
}

export interface QualityQueryOptions {
  granularity?: ChartGranularity;
  enabled?: boolean;
  passive?: boolean;
}

const IDLE_QUERY: QualityQueryState = { loading: false, rows: [] };

// Whether the window is narrow enough to be worth re-polling. Judged on the
// span the queries actually ran over — every one of them clamps its start to
// the ledger's first row, so the picker's own span can be many times wider than
// anything that was scanned, and gating on it would freeze a cheap window.
// An unknown span (coverage still loading, or failed) polls: the common case is
// a narrow window, and the alternative is a tab that never updates at all.
export function shouldAutoRefresh(coverageRow: any): boolean {
  const days = effectiveWindowDays(coverageRow);
  return days === undefined || days <= LARGE_WINDOW_DAYS;
}

// Panels that name the same query over the same window, mode and granularity
// build the same URL and therefore share one SWR key: the reverts query feeds
// the revert tile, its chart and the reverted table.
//
// A disabled query has no key and reads as idle rather than loading, so a chart
// that has nothing to fetch shows its empty state instead of a skeleton. A
// passive one has no fetcher: it only reads what another panel fetches under the
// same key, and so can never re-run that query.
//
// shadowMode is required and sits ahead of the defaulted autoRefresh so that
// every caller has to state it. Defaulted, a caller that omitted it would drop
// the key from the JSON blob entirely, pinning its SWR key while the rest of the
// page moved — and the page's tiles are cross-checkable only while they all
// describe one population.
//
// revalidateOnFocus is off in both refresh modes. On a narrow window the poll
// already bounds staleness, so focus events only add page-wide recomputes at a
// rate set by tab switching; on a wide window it would defeat the suppression
// this page just applied.
export function useQualityQuery(
  queryName: string,
  startTime: string,
  stopTime: string,
  shadowMode: ShadowMode,
  autoRefresh: boolean = true,
  { granularity, enabled = true, passive = false }: QualityQueryOptions = {}
): QualityQueryState {
  const { data, error } = useSWR(
    enabled
      ? qualityUrl(queryName, startTime, stopTime, shadowMode, granularity)
      : null,
    passive ? null : fetcher,
    {
      refreshInterval: autoRefresh ? REFRESH_INTERVAL_MS : 0,
      revalidateOnFocus: false,
    }
  );
  return enabled ? readQuery(queryName, data, error) : IDLE_QUERY;
}

// The API route has no error handling, so a failing query answers with an HTML
// error page and fetcher rejects on res.json(). Without this the panels would
// sit on a skeleton forever instead of naming the query that failed.
function readQuery(
  queryName: string,
  data: any,
  error: any
): QualityQueryState {
  if (error !== undefined) {
    return {
      loading: false,
      error: `${queryName}: ${error?.message ?? error}`,
      rows: [],
    };
  }
  if (data === undefined) {
    return { loading: true, rows: [] };
  }
  if (!Array.isArray(data)) {
    return {
      loading: false,
      error: `${queryName}: ${data?.error ?? "unexpected query response"}`,
      rows: [],
    };
  }
  return { loading: false, rows: data, row: data[0] };
}
