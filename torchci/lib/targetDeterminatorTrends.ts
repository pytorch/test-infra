// The trend chart behind each Target Determinator tile: which rows feed it and
// how they land on day or week buckets.

import type { ChartType } from "components/metrics/panels/TimeSeriesPanel";
import {
  alignRows,
  bucketKey,
  bucketSpine,
  ChartBucket,
  ChartGranularity,
} from "lib/greenlight/qualityCharts";
import {
  BreakageOutcome,
  num,
  OUTCOME_LABELS,
  ratio,
} from "lib/targetDeterminatorRows";

export type TdChartKey =
  | "ciSaved"
  | "typicalJob"
  | "ttgSaved"
  | "hoursPerPush"
  | "ttrs"
  | "falseGreens"
  | "recall"
  | "traced"
  | "caught"
  | "secondHalf"
  | "samePicks"
  | "typicalChange";

export type TdSource =
  | "savings"
  | "pushWait"
  | "ttrs"
  | "breakages"
  | "ranks"
  | "churn";

// grain: the query's own day or week rows. weekly: TTRS's week rows, whatever
// the bucket size. events: one row per event, bucketed here by when it landed.
const SOURCE_KIND: Record<TdSource, "grain" | "weekly" | "events"> = {
  savings: "grain",
  pushWait: "grain",
  churn: "grain",
  ttrs: "weekly",
  breakages: "events",
  ranks: "events",
};

// Breakage tiles count only landings whose revert window has closed.
const EVENT_ROWS: Partial<Record<TdSource, (_row: any) => boolean>> = {
  breakages: (row) => row?.grain === "event" && num(row?.window_closed) === 1,
  ranks: (row) => row?.grain === "landing",
};

export type TdUnit = "hours" | "minutes" | "count" | "percent";

// sum and events are counts: a bucket without rows reads 0. stat and share
// read null there, and stat also where its own n is 0, so a quiet bucket breaks
// the line instead of plotting a figure nobody measured.
export type TdValue =
  | { kind: "sum"; field: string }
  | { kind: "stat"; field: string; n?: (_row: any) => number | null }
  | { kind: "share"; field: string; of: string }
  | { kind: "events"; where: (_row: any) => boolean };

export interface TdChartConfig {
  title: string;
  source: TdSource;
  unit: TdUnit;
  type: ChartType;
  series: { name: string; value: TdValue }[];
  note?: string;
}

const sum = (field: string): TdValue => ({ kind: "sum", field });
const stat = (field: string, n?: (_row: any) => number | null): TdValue => ({
  kind: "stat",
  field,
  n,
});
const events = (where: (_row: any) => boolean): TdValue => ({
  kind: "events",
  where,
});
const outcomeIs =
  (...outcomes: BreakageOutcome[]) =>
  (row: any) =>
    outcomes.includes(row?.outcome);
const flagIs = (name: string, flag: number) => (row: any) =>
  num(row?.[name]) === flag;
const count = (name: string) => (row: any) => num(row?.[name]);

export const TD_CHARTS: Record<TdChartKey, TdChartConfig> = {
  ciSaved: {
    title: "PR test-job hours: actual vs estimated full suite",
    source: "savings",
    unit: "hours",
    type: "line",
    series: [
      { name: "Actual, with TD", value: sum("pr_hours") },
      { name: "Estimated, full suite", value: sum("est_full_hours") },
    ],
    note: "The estimate gives each PR test job the mean duration of the same job on main over the whole counted range, so it does not follow changes on main within the range.",
  },
  typicalJob: {
    title: "Median test-job duration: PR vs main",
    source: "savings",
    unit: "minutes",
    type: "line",
    series: [
      { name: "PR jobs, with TD", value: stat("pr_median_min", count("jobs")) },
      {
        name: "Same jobs on main",
        value: stat("full_median_min", count("jobs")),
      },
    ],
  },
  ttgSaved: {
    title: "Median wait from push to the last test job",
    source: "pushWait",
    unit: "minutes",
    type: "line",
    series: [
      {
        name: "Actual",
        value: stat("actual_ttg_median_min", count("pushes")),
      },
      {
        name: "Estimated without TD",
        value: stat("est_ttg_median_min", count("pushes")),
      },
    ],
    note: "The tile's median saving per push is not the gap between these two medians.",
  },
  hoursPerPush: {
    title: "Test-job hours per green PR push",
    source: "pushWait",
    unit: "hours",
    type: "line",
    series: [
      { name: "With TD", value: stat("hours_per_push", count("pushes")) },
      {
        name: "Estimated without TD",
        value: stat("est_hours_per_push", count("pushes")),
      },
    ],
  },
  ttrs: {
    title: "Time to first red, weekly median",
    source: "ttrs",
    unit: "minutes",
    type: "line",
    series: [{ name: "Median", value: stat("custom") }],
    note: "Weekly whatever the bucket size. The query leaves out the newest week until it is complete.",
  },
  falseGreens: {
    title: "False greens",
    source: "breakages",
    unit: "count",
    type: "bar",
    series: [{ name: "False greens", value: events(outcomeIs("false_green")) }],
    note: "A count per bucket: the tile's share rests on too few breakages to chart per bucket.",
  },
  recall: {
    title: "Breakages where TD ran the breaking tests vs false greens",
    source: "breakages",
    unit: "count",
    type: "stacked_bar",
    series: [
      {
        name: "TD ran the breaking tests",
        value: events(outcomeIs("signal_on_pr", "passed_on_pr")),
      },
      { name: "False greens", value: events(outcomeIs("false_green")) },
    ],
  },
  traced: {
    title: "Reverted landings traced, by outcome",
    source: "breakages",
    unit: "count",
    type: "stacked_bar",
    series: (Object.keys(OUTCOME_LABELS) as BreakageOutcome[]).map(
      (outcome) => ({
        name: OUTCOME_LABELS[outcome],
        value: events(outcomeIs(outcome)),
      })
    ),
  },
  caught: {
    title: "Trunk breakages inside and outside TD's cut",
    source: "ranks",
    unit: "count",
    type: "stacked_bar",
    series: [
      { name: "Inside the cut", value: events(flagIs("inside_cut", 1)) },
      { name: "Outside the cut", value: events(flagIs("inside_cut", 0)) },
    ],
  },
  secondHalf: {
    title: "Trunk breakages caught only by the second half of TD's picks",
    source: "ranks",
    unit: "count",
    type: "bar",
    series: [{ name: "Second half", value: events(flagIs("second_half", 1)) }],
  },
  samePicks: {
    title: "Share of push pairs with the same picks",
    source: "churn",
    unit: "percent",
    type: "line",
    series: [
      {
        name: "Same picks",
        value: { kind: "share", field: "identical_pairs", of: "pairs" },
      },
    ],
  },
  typicalChange: {
    title: "Median change when picks change",
    source: "churn",
    unit: "percent",
    type: "line",
    series: [
      {
        name: "Median change",
        value: stat(
          "changed_median_pct",
          (row) => (num(row?.pairs) ?? 0) - (num(row?.identical_pairs) ?? 0)
        ),
      },
    ],
  },
};

export function chartElementId(key: TdChartKey): string {
  return `td-chart-${key}`;
}

// The range a chart covers. Buckets that start at or after countedUntil are
// not counted yet; buckets that end at or before countedFrom fall outside a
// truncated list of events. Both read null, never 0.
export interface PlotWindow {
  start: number;
  end: number;
  countedFrom?: number;
  countedUntil?: number;
}

export type BucketState = "full" | "partial" | "pending" | "truncated";

export interface TdPlot {
  granularity: ChartGranularity;
  buckets: ChartBucket[];
  states: BucketState[];
  values: (number | null)[][];
}

function bucketState(bucket: ChartBucket, window: PlotWindow): BucketState {
  const from = bucket.start.valueOf();
  const to = bucket.end.valueOf();
  const inside = (t: number | undefined) =>
    t !== undefined && from < t && t < to;
  if (window.countedUntil !== undefined && from >= window.countedUntil) {
    return "pending";
  }
  if (window.countedFrom !== undefined && to <= window.countedFrom) {
    return "truncated";
  }
  return bucket.partial ||
    inside(window.countedUntil) ||
    inside(window.countedFrom)
    ? "partial"
    : "full";
}

function bucketInputs(
  source: TdSource,
  rows: any[],
  buckets: ChartBucket[],
  granularity: ChartGranularity
): any[] {
  const kind = SOURCE_KIND[source];
  if (kind !== "events") {
    const own =
      kind === "grain" ? rows.filter((r) => r?.grain === granularity) : rows;
    return alignRows(buckets, own, "bucket", granularity);
  }
  const position = new Map(buckets.map((bucket, i) => [bucket.key, i]));
  const grouped: any[][] = buckets.map(() => []);
  const keep = EVENT_ROWS[source] ?? (() => true);
  for (const row of rows) {
    const i = keep(row)
      ? position.get(bucketKey(row?.landed_at, granularity) ?? "")
      : undefined;
    if (i !== undefined) {
      grouped[i].push(row);
    }
  }
  return grouped;
}

export function bucketValue(value: TdValue, input: any): number | null {
  switch (value.kind) {
    case "sum":
      return num(input?.[value.field]) ?? 0;
    case "stat":
      return input === undefined ||
        (value.n !== undefined && !((value.n(input) ?? 0) > 0))
        ? null
        : num(input[value.field]);
    case "share": {
      const share = ratio(input?.[value.field], input?.[value.of]);
      return share === null ? null : share * 100;
    }
    case "events":
      return Array.isArray(input) ? input.filter(value.where).length : 0;
  }
}

export function buildPlot(
  chart: TdChartConfig,
  rows: any[],
  picked: ChartGranularity,
  window: PlotWindow
): TdPlot {
  const granularity = SOURCE_KIND[chart.source] === "weekly" ? "week" : picked;
  const buckets = bucketSpine(
    {
      effective_start: new Date(window.start).toISOString(),
      effective_end: new Date(window.end).toISOString(),
    },
    granularity
  );
  const inputs = bucketInputs(chart.source, rows, buckets, granularity);
  const states = buckets.map((bucket) => bucketState(bucket, window));
  return {
    granularity,
    buckets,
    states,
    values: chart.series.map(({ value }) =>
      inputs.map((input, i) =>
        states[i] === "pending" || states[i] === "truncated"
          ? null
          : bucketValue(value, input)
      )
    ),
  };
}
