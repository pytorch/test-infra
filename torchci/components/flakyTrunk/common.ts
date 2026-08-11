import { GridColDef } from "@mui/x-data-grid";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";

export const FLAKY_TRUNK_REPO = "pytorch/pytorch";

export const DEFAULT_TIME_RANGE = 30;
export const DEFAULT_GRANULARITY: Granularity = "day";
export const DEFAULT_MIN_RUNS = 20;
export const DEFAULT_METRIC: MetricKey = "flake_rate";
export const DEFAULT_ENTITY: EntityKey = "jobs";

// ClickHouse DateTime64(3) literal expected by the flaky_trunk_* queries.
export const CLICKHOUSE_TIME_FORMAT = "YYYY-MM-DDTHH:mm:ss.SSS";

export type MetricKey =
  | "flake_rate"
  | "pct_reds_flake"
  | "red"
  | "flake"
  | "unknown"
  | "total_runs";

export type EntityKey = "jobs" | "labels";

export interface MetricOption {
  value: MetricKey;
  label: string;
  // Rate metrics are 0-1 floats rendered as percentages on a fixed 0-100% axis;
  // count metrics are integers on an auto-scaled axis starting at 0.
  isRate: boolean;
}

export const METRIC_OPTIONS: MetricOption[] = [
  { value: "flake_rate", label: "Flake rate", isRate: true },
  { value: "pct_reds_flake", label: "% of reds that are flaky", isRate: true },
  { value: "red", label: "Reds", isRate: false },
  { value: "flake", label: "Flakes", isRate: false },
  { value: "unknown", label: "Unknown reds", isRate: false },
  { value: "total_runs", label: "Total runs", isRate: false },
];

export function getMetricOption(value: MetricKey): MetricOption {
  return METRIC_OPTIONS.find((m) => m.value === value) ?? METRIC_OPTIONS[0];
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
