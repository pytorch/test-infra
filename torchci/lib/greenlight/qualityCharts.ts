// Bucketing GreenLight quality query rows onto the time axis the per-tile charts
// share.

import { intFormatter } from "components/common/numberFormat";
import { snapToGranularity } from "components/common/timeWindow";
import dayjs from "dayjs";
import {
  ABSENT,
  effectiveWindow,
  finiteNumber,
  formatUtcSpan,
  hasCount,
  parseStamp,
  pctOf,
  percentUnitsFormatter,
  secondsFormatter,
} from "lib/greenlight/qualityFigures";
import type {
  CoverageRow,
  LatencyRow,
  MergeAuthorityRow,
} from "lib/greenlight/qualityQuery";

export type ChartGranularity = "day" | "week";

export interface ChartGranularityOption {
  value: ChartGranularity;
  label: string;
}

export const CHART_GRANULARITY_OPTIONS: ChartGranularityOption[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
];

const DAILY_BUCKETS_MAX_DAYS = 90;

// TimeRangePicker's value for a range set by hand.
const CUSTOM_TIME_RANGE = -1;

const MINUTES_PER_DAY = 24 * 60;
const SECONDS_PER_MINUTE = 60;
const BUCKET_KEY_FORMAT = "YYYY-MM-DD";
const BUCKET_LABEL_FORMAT = "MMM D";

export function defaultGranularity(
  rangeDays: number | undefined
): ChartGranularity {
  return rangeDays === undefined || rangeDays <= DAILY_BUCKETS_MAX_DAYS
    ? "day"
    : "week";
}

// The span the user picked, in days: the preset itself, or a Custom range's
// stop − start in whole local-calendar minutes. Whole, so the millisecond
// between two reads of "now" cannot tip exactly 90 days over the line; local,
// so a DST change inside the range does not add or remove an hour. Undefined
// while a Custom bound is absent or invalid, as the date field leaves it
// mid-edit.
export function pickedRangeDays(
  timeRange: number,
  startTime: dayjs.Dayjs | null | undefined,
  stopTime: dayjs.Dayjs | null | undefined
): number | undefined {
  if (timeRange !== CUSTOM_TIME_RANGE) {
    return timeRange;
  }
  if (!startTime?.isValid() || !stopTime?.isValid()) {
    return undefined;
  }
  return (
    (stopTime.diff(startTime, "minute") +
      stopTime.utcOffset() -
      startTime.utcOffset()) /
    MINUTES_PER_DAY
  );
}

export type PickerChange = "range" | "bound";

// Whether a picker change drops the bucket size the user chose. A new range
// does, and so does editing a Custom range's start or stop; the preset's
// periodic refresh moves start and stop outside Custom and keeps it.
export function clearsGranularityOverride(
  change: PickerChange,
  timeRange: number
): boolean {
  return change === "range" || timeRange === CUSTOM_TIME_RANGE;
}

export interface ChartBucket {
  // The UTC date the whole day or ISO week starts on.
  key: string;
  // The part of the bucket inside the window, end exclusive.
  start: dayjs.Dayjs;
  end: dayjs.Dayjs;
  partial: boolean;
  label: string;
}

// Snapped rather than read as-is: a revert's reverted_at is a raw timestamp and
// has to land on the day or Monday it falls in, as the queries' bucket starts
// already do.
export function bucketKey(
  value: unknown,
  granularity: ChartGranularity
): string | undefined {
  const parsed = parseStamp(value);
  return parsed === undefined
    ? undefined
    : snapToGranularity(parsed, granularity).format(BUCKET_KEY_FORMAT);
}

// Every UTC day or ISO week the effective window touches. All charts map their
// rows onto this one spine, so they share an x-axis. It comes from coverage's
// window because latency and merge_authority clamp to the unfiltered ledger
// start: in shadow mode they return buckets from before the charted population
// begins, and those fall off here. An empty or unknown window has no buckets.
export function bucketSpine(
  coverageRow: any,
  granularity: ChartGranularity
): ChartBucket[] {
  const bounds = effectiveWindow(coverageRow);
  if (bounds === undefined || !bounds.end.isAfter(bounds.start)) {
    return [];
  }
  const { start, end } = bounds;
  const buckets: ChartBucket[] = [];
  for (
    let from = snapToGranularity(start, granularity);
    from.isBefore(end);
    from = from.add(1, granularity)
  ) {
    const to = from.add(1, granularity);
    const coveredStart = from.isBefore(start) ? start : from;
    const coveredEnd = to.isAfter(end) ? end : to;
    buckets.push({
      key: from.format(BUCKET_KEY_FORMAT),
      start: coveredStart,
      end: coveredEnd,
      partial: !coveredStart.isSame(from) || !coveredEnd.isSame(to),
      label: from.format(BUCKET_LABEL_FORMAT),
    });
  }
  return buckets;
}

export function bucketSpan(bucket: ChartBucket): string {
  return formatUtcSpan(bucket.start, bucket.end);
}

// Where a chart's buckets come from: a query run at day or week granularity,
// keyed by the bucket column it adds, or the reverts query's rows, which
// revertRowsBySpine buckets by when each revert landed.
export type ChartSource =
  | { query: "coverage"; bucketField: keyof CoverageRow }
  | { query: "latency"; bucketField: keyof LatencyRow }
  | { query: "mergeAuthority"; bucketField: keyof MergeAuthorityRow }
  | { query: "reverts" };

// The query row each spine bucket maps to, in spine order: undefined where the
// query returned none. Rows keyed outside the spine are dropped.
export function alignRows(
  spine: ChartBucket[],
  rows: any[],
  bucketField: string,
  granularity: ChartGranularity
): any[] {
  const byKey = new Map<string, any>();
  for (const row of rows) {
    const key = bucketKey(row?.[bucketField], granularity);
    if (key !== undefined) {
      byKey.set(key, row);
    }
  }
  return spine.map((bucket) => byKey.get(bucket.key));
}

// The reverts the revert tile's numerator counts, as the query flags them,
// grouped by the spine bucket each landed in. A revert landing outside the
// spine is in no group.
export function revertRowsBySpine(
  spine: ChartBucket[],
  rows: any[],
  granularity: ChartGranularity
): any[][] {
  const position = new Map(spine.map((bucket, i) => [bucket.key, i]));
  const grouped: any[][] = spine.map(() => []);
  for (const row of rows) {
    if (row?.counts_in_rate !== 1) {
      continue;
    }
    const i = position.get(bucketKey(row?.reverted_at, granularity) ?? "");
    if (i !== undefined) {
      grouped[i].push(row);
    }
  }
  return grouped;
}

// How a series reads its figure off one bucket. Counts are bars, and read 0 for
// a bucket the query returned no row for. Shares and medians are lines, and read
// null there and wherever their own n is 0, so a quiet bucket breaks the line
// instead of plotting a 0% or a zero-minute median nobody measured.
export type ChartValue =
  | { kind: "count"; countField: string }
  | { kind: "rowCount"; countOf: (_row: any) => number | undefined }
  | { kind: "share"; countField: string; denominatorField: string }
  | { kind: "queryShare"; pctField: string }
  | { kind: "p50Minutes"; secondsField: string; nField: string }
  | { kind: "revertCount" };

export type AxisRole = "count" | "share" | "minutes";

export function valueAxis(value: ChartValue): AxisRole {
  switch (value.kind) {
    case "count":
    case "rowCount":
    case "revertCount":
      return "count";
    case "share":
    case "queryShare":
      return "share";
    case "p50Minutes":
      return "minutes";
  }
}

// `input` is the bucket's query row, or for revertCount the reverts that landed
// in the bucket. A median that is not positive reads null too: the minutes axis
// is logarithmic and cannot place it.
export function bucketValue(value: ChartValue, input: any): number | null {
  switch (value.kind) {
    case "count":
      return finiteNumber(input?.[value.countField]) ?? 0;
    case "rowCount":
      return input === undefined ? 0 : finiteNumber(value.countOf(input)) ?? 0;
    case "share":
      return (
        pctOf(input?.[value.countField], input?.[value.denominatorField]) ??
        null
      );
    case "queryShare":
      return finiteNumber(input?.[value.pctField]) ?? null;
    case "p50Minutes": {
      const seconds = finiteNumber(input?.[value.secondsField]);
      return hasCount(input?.[value.nField]) &&
        seconds !== undefined &&
        seconds > 0
        ? seconds / SECONDS_PER_MINUTE
        : null;
    }
    case "revertCount":
      return Array.isArray(input) ? input.length : 0;
  }
}

// The median is formatted from the row's own seconds, so a measured median the
// log axis could not place still reads as measured here.
export function bucketValueText(
  value: ChartValue,
  input: any,
  plotted: number | null
): string {
  switch (value.kind) {
    case "count":
    case "rowCount":
    case "revertCount":
      return intFormatter(plotted);
    case "share":
    case "queryShare":
      return percentUnitsFormatter(plotted);
    case "p50Minutes":
      return hasCount(input?.[value.nField])
        ? secondsFormatter(input?.[value.secondsField])
        : ABSENT;
  }
}

export interface ChartPlot {
  inputs: any[];
  values: (number | null)[][];
  // The query returned rows but none of them falls on the spine, so plotting
  // them would draw zeros for buckets that were never counted.
  misaligned: boolean;
}

// A chart's input per spine bucket, and the value each of its series plots from
// it: the query row the bucket maps to, or for the reverts chart the reverts the
// tile counts that landed in the bucket.
export function chartPlot(
  spine: ChartBucket[],
  rows: any[],
  granularity: ChartGranularity,
  source: ChartSource,
  values: ChartValue[]
): ChartPlot {
  const inputs =
    source.query === "reverts"
      ? revertRowsBySpine(spine, rows, granularity)
      : alignRows(spine, rows, source.bucketField, granularity);
  return {
    inputs,
    values: values.map((value) =>
      inputs.map((input) => bucketValue(value, input))
    ),
    misaligned:
      source.query !== "reverts" &&
      spine.length > 0 &&
      rows.length > 0 &&
      inputs.every((input) => input === undefined),
  };
}

// How many of the tile's reverts the reverts chart placed on its spine.
export function chartedReverts(plot: ChartPlot): number {
  return plot.inputs.reduce<number>(
    (total, group) => total + (Array.isArray(group) ? group.length : 0),
    0
  );
}
