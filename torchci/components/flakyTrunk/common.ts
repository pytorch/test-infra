import { GridColDef } from "@mui/x-data-grid";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";

export const FLAKY_TRUNK_REPO = "pytorch/pytorch";

export const DEFAULT_TIME_RANGE = 30;
export const DEFAULT_GRANULARITY: Granularity = "day";
export const DEFAULT_MIN_RUNS = 20;
export const DEFAULT_DENOMINATOR: DenominatorKey = "jobs";

// Windows wider than this disable the table auto-refresh so an idle long-range
// tab does not keep re-running the heavy per-label query.
export const LARGE_WINDOW_DAYS = 90;

// ClickHouse DateTime64(3) literal expected by the flaky_trunk_* queries.
export const CLICKHOUSE_TIME_FORMAT = "YYYY-MM-DDTHH:mm:ss.SSS";

export type DenominatorKey = "jobs" | "reds";

// A single stacked-bar slice: the count column in flaky_trunk_timeseries and its
// series label. The three slices partition (red - real): every red that is not a
// confirmed regression is an infra flake, a test flake, or still unclassified.
export interface FlakeSlice {
  key: string;
  label: string;
}

export const FLAKE_SLICES: FlakeSlice[] = [
  { key: "infra_flake", label: "Infra flakiness" },
  { key: "test_flake", label: "Job flakiness" },
  { key: "unknown", label: "Unclassified" },
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
  return Number.isFinite(parsed) ? parsed : fallback;
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
