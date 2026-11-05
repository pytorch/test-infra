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
import { parseStamp } from "lib/greenlight/qualityFigures";
import { TD_SCOPE, type TdWorkflow } from "lib/targetDeterminator";
import {
  BreakageOutcome,
  num,
  OUTCOME_LABELS,
  ratio,
} from "lib/targetDeterminatorRows";

const WORKFLOW_CHARTS = ["workflowSaved", "workflowJob"] as const;
type TdWorkflowChart = (typeof WORKFLOW_CHARTS)[number];
type TdWorkflowChartKey = `${TdWorkflowChart}-${TdWorkflow}`;

export type TdChartKey =
  | "ciSaved"
  | TdWorkflowChartKey
  | "ttgSaved"
  | "hoursPerPush"
  | "falseGreens"
  | "recall"
  | "traced"
  | "caught"
  | "samePicks"
  | "typicalChange";

export type TdSource = "savings" | "pushWait" | "breakages" | "ranks" | "churn";

// grain: the query's own day or week rows, or for a chart with a workflow that
// workflow's workflow_day or workflow_week rows. A function: one row per event
// it keeps, bucketed here by when it landed. Breakage tiles count only landings
// whose revert window has closed.
const SOURCE_ROWS: Record<TdSource, "grain" | ((_row: any) => boolean)> = {
  savings: "grain",
  pushWait: "grain",
  churn: "grain",
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
  axisLabel?: string;
  type: ChartType;
  series: { name: string; value: TdValue }[];
  note?: string;
  workflow?: TdWorkflow;
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

const CI_SAVED: TdChartConfig = {
  title: "PR test-job hours: actual vs estimated full suite",
  source: "savings",
  unit: "hours",
  type: "line",
  series: [
    { name: "Actual, with TD", value: sum("pr_hours") },
    { name: "Estimated, full suite", value: sum("est_full_hours") },
  ],
  note: "The estimate gives each PR test job the mean duration of the same job on main over the whole counted range, so it does not follow changes on main within the range.",
};

const jobStat = (field: string) => stat(field, count("jobs"));

// The tooltip renders series names as HTML: titles and names here are fixed
// text and TD_SCOPE's workflow list, never row data.
const WORKFLOW_CHART_CONFIGS: Record<
  TdWorkflowChart,
  (_workflow: TdWorkflow) => TdChartConfig
> = {
  workflowSaved: (workflow) => ({
    ...CI_SAVED,
    title: `CI time saved, ${workflow} workflow`,
    workflow,
  }),
  workflowJob: (workflow) => ({
    title: `Typical ${workflow} workflow test job`,
    source: "savings",
    unit: "minutes",
    type: "line",
    workflow,
    series: [
      { name: "Median, with TD", value: jobStat("pr_median_min") },
      { name: "Median, every test", value: jobStat("full_median_min") },
      { name: "p90, with TD", value: jobStat("pr_p90_min") },
      { name: "p90, every test", value: jobStat("full_p90_min") },
    ],
    note: "The every-test lines give each PR test job the median duration of the same job on main over the whole counted range, so they do not follow changes on main within the range: they move only with the day's mix of jobs, the p90 line most.",
  }),
};

export function workflowChartKey(
  chart: TdWorkflowChart,
  workflow: TdWorkflow
): TdWorkflowChartKey {
  return `${chart}-${workflow}`;
}

const WORKFLOW_TD_CHARTS = Object.fromEntries(
  WORKFLOW_CHARTS.flatMap((chart) =>
    TD_SCOPE.tdWorkflows.map((workflow) => [
      workflowChartKey(chart, workflow),
      WORKFLOW_CHART_CONFIGS[chart](workflow),
    ])
  )
) as Record<TdWorkflowChartKey, TdChartConfig>;

export const WORKFLOW_CHART_KEYS = Object.keys(
  WORKFLOW_TD_CHARTS
) as TdWorkflowChartKey[];

export const TD_CHARTS: Record<TdChartKey, TdChartConfig> = {
  ciSaved: CI_SAVED,
  ...WORKFLOW_TD_CHARTS,
  ttgSaved: {
    title: "Median wait from push to the last test job, and median saving",
    source: "pushWait",
    unit: "minutes",
    type: "line",
    series: [
      {
        name: "Median saving per push",
        value: stat("saved_median_min", count("pushes")),
      },
      {
        name: "Actual wait",
        value: stat("actual_ttg_median_min", count("pushes")),
      },
      {
        name: "Estimated wait without TD",
        value: stat("est_ttg_median_min", count("pushes")),
      },
    ],
    note: "The median saving per push is not the gap between the two median waits.",
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
  falseGreens: {
    title: "False greens",
    source: "breakages",
    unit: "count",
    type: "bar",
    series: [{ name: "False greens", value: events(outcomeIs("false_green")) }],
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
    axisLabel: "% of test files",
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
// not counted yet and read null, never 0. Buckets that start before
// upperBoundBefore are charted but marked as upper bounds.
export interface PlotWindow {
  start: number;
  end: number;
  countedUntil?: number;
  upperBoundBefore?: number;
}

export type BucketState = "full" | "partial" | "pending";

export interface TdPlot {
  granularity: ChartGranularity;
  buckets: ChartBucket[];
  states: BucketState[];
  upperBound: boolean[];
  values: (number | null)[][];
}

function bucketState(bucket: ChartBucket, window: PlotWindow): BucketState {
  const from = bucket.start.valueOf();
  const until = window.countedUntil;
  if (until !== undefined && from >= until) {
    return "pending";
  }
  return bucket.partial ||
    (until !== undefined && from < until && until < bucket.end.valueOf())
    ? "partial"
    : "full";
}

function bucketInputs(
  chart: TdChartConfig,
  rows: any[],
  buckets: ChartBucket[],
  granularity: ChartGranularity
): any[] {
  const keep = SOURCE_ROWS[chart.source];
  if (keep === "grain") {
    const own = rows.filter(
      chart.workflow === undefined
        ? (r) => r?.grain === granularity
        : (r) =>
            r?.grain === `workflow_${granularity}` &&
            r?.workflow === chart.workflow
    );
    return alignRows(buckets, own, "bucket", granularity);
  }
  if (buckets.length === 0) {
    return [];
  }
  const position = new Map(buckets.map((bucket, i) => [bucket.key, i]));
  const grouped: any[][] = buckets.map(() => []);
  const first = buckets[0].start.valueOf();
  const last = buckets[buckets.length - 1].end.valueOf();
  for (const row of rows) {
    if (!keep(row)) {
      continue;
    }
    // A row outside the axis goes to the nearest end bucket, so the buckets
    // still add up to the tile that counted it.
    const time = parseStamp(row?.landed_at)?.valueOf();
    const i =
      time === undefined
        ? undefined
        : time < first
        ? 0
        : time >= last
        ? buckets.length - 1
        : position.get(bucketKey(row.landed_at, granularity) ?? "");
    if (i !== undefined) {
      grouped[i].push(row);
    }
  }
  return grouped;
}

function bucketValue(value: TdValue, input: any): number | null {
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
  granularity: ChartGranularity,
  window: PlotWindow
): TdPlot {
  const buckets = bucketSpine(
    {
      effective_start: new Date(window.start).toISOString(),
      effective_end: new Date(window.end).toISOString(),
    },
    granularity
  );
  const inputs = bucketInputs(chart, rows, buckets, granularity);
  const states = buckets.map((bucket) => bucketState(bucket, window));
  return {
    granularity,
    buckets,
    states,
    upperBound: buckets.map(
      (bucket) =>
        window.upperBoundBefore !== undefined &&
        bucket.start.valueOf() < window.upperBoundBefore
    ),
    values: chart.series.map(({ value }) =>
      inputs.map((input, i) =>
        states[i] === "pending" ? null : bucketValue(value, input)
      )
    ),
  };
}
