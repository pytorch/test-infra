import { GridColDef } from "@mui/x-data-grid";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";

export const FLAKY_TRUNK_REPO = "pytorch/pytorch";

export const DEFAULT_TIME_RANGE = 30;
// The presets offered by TimeRangePicker (days), plus -1 for a custom range.
export const ALLOWED_TIME_RANGES = [1, 3, 7, 14, 30, 90, 180, 365, -1];
export const DEFAULT_GRANULARITY: Granularity = "day";
export const DEFAULT_MIN_RUNS = 20;
export const DEFAULT_DENOMINATOR: DenominatorKey = "jobs";

// Windows wider than this disable the table auto-refresh so an idle long-range
// tab does not keep re-running the heavy per-label query.
export const LARGE_WINDOW_DAYS = 90;

// ClickHouse DateTime64(3) literal expected by the flaky_trunk_* queries.
export const CLICKHOUSE_TIME_FORMAT = "YYYY-MM-DDTHH:mm:ss.SSS";

// Snap a window START down to its granularity bucket before it becomes a query
// timestamp. TimeRangePicker re-derives "now" every 5 min, which would otherwise
// churn the SWR key every render; snapping keeps the key stable within a bucket
// (dedupes the graph/tiles fetch and stops needless heavy re-runs).
export function snapToGranularity(
  time: dayjs.Dayjs,
  granularity: Granularity
): dayjs.Dayjs {
  return time.utc().startOf(granularity);
}

// Snap a window STOP up to the start of the NEXT bucket, so the (exclusive) upper
// bound includes the current in-progress bucket while staying fixed for that
// bucket's whole duration — same key-stability benefit, without hiding today.
export function snapStopToGranularity(
  time: dayjs.Dayjs,
  granularity: Granularity
): dayjs.Dayjs {
  return snapToGranularity(time, granularity).add(1, granularity);
}

export type DenominatorKey = "jobs" | "reds";

export type EntityType = "job" | "label";

// The job or runner label whose individual flaky runs the drill-down table shows.
export interface SelectedEntity {
  type: EntityType;
  value: string;
}

// A single stacked-bar slice: the count column in flaky_trunk_timeseries and its
// series label. The graph plots flakiness only; the persistent-break category
// (real_regression) lives in the tiles, so in "% of reds" mode these three
// slices intentionally do not stack to 100%.
export interface FlakeSlice {
  key: string;
  label: string;
}

export const FLAKE_SLICES: FlakeSlice[] = [
  { key: "infra_flake", label: "Infra flakiness" },
  { key: "test_flake", label: "Job flakiness" },
  { key: "unclassified", label: "Unclassified" },
];

// Whole-window stat tiles: each sums its count column across the timeseries
// buckets and is shown alongside its share of all reds (Σkey / Σred).
export interface TileConfig {
  key: string;
  label: string;
}

export const TILE_CONFIGS: TileConfig[] = [
  { key: "real_regression", label: "Real regressions" },
];

// The denominator each slice count is divided by to get its plotted percentage.
export interface DenominatorOption {
  value: DenominatorKey;
  label: string;
  field: string;
}

export const DENOMINATOR_OPTIONS: DenominatorOption[] = [
  { value: "jobs", label: "% of all jobs", field: "total_runs" },
  { value: "reds", label: "% of reds", field: "red" },
];

export function getDenominatorOption(value: DenominatorKey): DenominatorOption {
  return (
    DENOMINATOR_OPTIONS.find((d) => d.value === value) ?? DENOMINATOR_OPTIONS[0]
  );
}

// Must reproduce the exact SWR key TimeSeriesPanel builds for the graph — it
// stringifies { ...queryParams, granularity } and the graph passes queryParams
// { startTime, stopTime, repo } in this order — so the tiles' fetch and the
// graph's fetch share one request instead of hitting the query twice.
export function flakyTrunkTimeseriesUrl(
  startTime: string,
  stopTime: string,
  granularity: string
): string {
  return `/api/clickhouse/flaky_trunk_timeseries?parameters=${encodeURIComponent(
    JSON.stringify({
      startTime,
      stopTime,
      repo: FLAKY_TRUNK_REPO,
      granularity,
    })
  )}`;
}

// A [start, end) time bucket selected by clicking a bar. end is exclusive.
export interface BucketRange {
  start: dayjs.Dayjs;
  end: dayjs.Dayjs;
}

// URL params are attacker-controlled free text, so every value is whitelisted on
// read with a safe fallback. Without this an unknown granularity or a
// non-numeric minRuns/timeRange freezes the page (bad tab / stuck skeleton).
export function parseGranularity(value: unknown): Granularity {
  return value === "day" || value === "week" || value === "month"
    ? value
    : DEFAULT_GRANULARITY;
}

export function parseDenominator(value: unknown): DenominatorKey {
  return value === "jobs" || value === "reds" ? value : DEFAULT_DENOMINATOR;
}

export function parseMinRuns(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : DEFAULT_MIN_RUNS;
}

export function parseTimeRange(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return ALLOWED_TIME_RANGES.includes(parsed) ? parsed : fallback;
}

export function parseDate(value: unknown, fallback: dayjs.Dayjs): dayjs.Dayjs {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed : fallback;
}

export function percentFormatter(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return `${(value * 100).toFixed(1)}%`;
}

export function intFormatter(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return Number(value).toLocaleString();
}

export function numCol(
  field: string,
  headerName: string,
  description?: string
): GridColDef {
  return {
    field,
    headerName,
    description,
    flex: 1,
    minWidth: 90,
    type: "number",
    valueFormatter: (value: number) => intFormatter(value),
  };
}

export function pctCol(
  field: string,
  headerName: string,
  description?: string
): GridColDef {
  return {
    field,
    headerName,
    description,
    flex: 1,
    minWidth: 110,
    type: "number",
    valueFormatter: (value: number) => percentFormatter(value),
  };
}

// Human-readable label for a [start, end) bucket range. end is exclusive, so the
// displayed upper bound is end - 1 day; single-day buckets collapse to one date.
export function formatBucketRange(
  start: dayjs.Dayjs,
  end: dayjs.Dayjs
): string {
  const fmt = "MMM D, YYYY";
  const inclusiveEnd = end.subtract(1, "day");
  if (start.isSame(inclusiveEnd, "day")) {
    return start.format(fmt);
  }
  return `${start.format(fmt)} – ${inclusiveEnd.format(fmt)}`;
}
