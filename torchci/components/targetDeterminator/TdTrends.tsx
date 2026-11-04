import {
  Box,
  Grid,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { intFormatter } from "components/common/numberFormat";
import InfoTooltip from "components/greenlight/quality/InfoTooltip";
import type { TileToggleProps } from "components/greenlight/quality/QualityTile";
import { TimeSeriesPanelWithData } from "components/metrics/panels/TimeSeriesPanel";
import type { EChartsOption } from "echarts";
import {
  bucketSpan,
  CHART_GRANULARITY_OPTIONS,
  ChartBucket,
  ChartGranularity,
} from "lib/greenlight/qualityCharts";
import { percentUnitsFormatter } from "lib/greenlight/qualityFigures";
import {
  DAY_MS,
  hoursText,
  minutesText,
  REVERT_WINDOW_DAYS,
} from "lib/targetDeterminator";
import {
  buildPlot,
  chartElementId,
  PlotWindow,
  TD_CHARTS,
  TdChartConfig,
  TdChartKey,
  TdPlot,
  TdSource,
  TdUnit,
} from "lib/targetDeterminatorTrends";
import { useMemo } from "react";
import { CHART_HEIGHT, TdPanel } from "./TdPanel";

const UNIT_TEXT: Record<TdUnit, (_value: number | null) => string> = {
  hours: hoursText,
  minutes: minutesText,
  count: intFormatter,
  percent: percentUnitsFormatter,
};

const UNIT_AXIS: Record<
  TdUnit,
  { label: string; tick: (_value: number) => string }
> = {
  hours: { label: "Hours", tick: (v) => Number(v).toLocaleString() },
  minutes: { label: "Minutes", tick: (v) => Number(v).toLocaleString() },
  count: { label: "Count", tick: (v) => Number(v).toLocaleString() },
  percent: { label: "% of pairs", tick: (v) => `${v}%` },
};

const PARTIAL_OPACITY = 0.45;
const PARTIAL_SYMBOL_SIZE = 8;
const UNCOUNTED_FILL = "rgba(128, 128, 128, 0.15)";
const UNCOUNTED_TEXT: Record<"pending" | "truncated", string> = {
  pending: "Not yet counted",
  truncated: "Not charted",
};
const UNCOUNTED_NOTE: Record<"pending" | "truncated", string> = {
  pending: `Not yet counted: landings from the last ${REVERT_WINDOW_DAYS} days may still be reverted.`,
  truncated: "Not charted: older than the newest landings the query lists.",
};

function bucketTime(bucket: ChartBucket): number {
  return Date.parse(`${bucket.key}T00:00:00.000Z`);
}

function halfBucket(plot: TdPlot): number {
  return ((plot.granularity === "week" ? 7 : 1) * DAY_MS) / 2;
}

// Runs of not-counted buckets, shaded and labelled on the chart.
function uncountedAreas(plot: TdPlot) {
  const half = halfBucket(plot);
  const areas: object[] = [];
  plot.states.forEach((state, i) => {
    if (state !== "pending" && state !== "truncated") {
      return;
    }
    const from = bucketTime(plot.buckets[i]) - half;
    const to = bucketTime(plot.buckets[i]) + half;
    const previous = areas[areas.length - 1] as any;
    if (previous !== undefined && previous[0].name === UNCOUNTED_TEXT[state]) {
      previous[1].xAxis = to;
    } else {
      areas.push([{ name: UNCOUNTED_TEXT[state], xAxis: from }, { xAxis: to }]);
    }
  });
  return areas;
}

export function plotSeries(chart: TdChartConfig, plot: TdPlot) {
  const areas = uncountedAreas(plot);
  return chart.series.map(({ name }, j) => ({
    name,
    type: chart.type === "line" ? "line" : "bar",
    stack: chart.type === "stacked_bar" ? "Total" : "",
    symbol: "circle",
    symbolSize: 5,
    connectNulls: false,
    emphasis: { focus: "series" },
    data: plot.buckets.map((bucket, i) => ({
      value: [bucketTime(bucket), plot.values[j][i]],
      ...(plot.states[i] === "partial"
        ? {
            itemStyle: { opacity: PARTIAL_OPACITY },
            symbol: "emptyCircle",
            symbolSize: PARTIAL_SYMBOL_SIZE,
          }
        : {}),
    })),
    ...(j === 0 && areas.length > 0
      ? {
          markArea: {
            silent: true,
            itemStyle: { color: UNCOUNTED_FILL },
            label: { position: "insideTop" },
            data: areas,
          },
        }
      : {}),
  }));
}

export function tooltipText(
  chart: TdChartConfig,
  plot: TdPlot,
  index: number,
  markers: string[] = []
): string {
  const bucket = plot.buckets[index];
  const state = plot.states[index];
  if (bucket === undefined) {
    return "";
  }
  const head =
    plot.granularity === "week" ? `Week of ${bucket.key}` : bucket.key;
  const lines = [`<b>${head}</b>`];
  if (state === "pending" || state === "truncated") {
    lines.push(UNCOUNTED_NOTE[state]);
    return lines.join("<br/>");
  }
  if (state === "partial") {
    lines.push(`Partial bucket: ${bucketSpan(bucket)}`);
  }
  const text = UNIT_TEXT[chart.unit];
  chart.series.forEach(({ name }, j) => {
    lines.push(`${markers[j] ?? ""}${name}: ${text(plot.values[j][index])}`);
  });
  if (chart.type === "stacked_bar") {
    const total = plot.values.reduce((sum, v) => sum + (v[index] ?? 0), 0);
    lines.push(`Total: ${text(total)}`);
  }
  return lines.join("<br/>");
}

// Every bucket of the range stays on the axis, even where no series has a
// value.
export function plotOptions(chart: TdChartConfig, plot: TdPlot): EChartsOption {
  const half = halfBucket(plot);
  const first = plot.buckets[0];
  const last = plot.buckets[plot.buckets.length - 1];
  return {
    xAxis:
      first === undefined
        ? {}
        : { min: bucketTime(first) - half, max: bucketTime(last) + half },
    grid: { containLabel: true },
    yAxis: { min: 0, ...(chart.unit === "count" ? { minInterval: 1 } : {}) },
    tooltip: {
      trigger: "axis",
      formatter: (params: any) => {
        const items = Array.isArray(params) ? params : [params];
        const markers = chart.series.map(
          ({ name }) =>
            items.find((item: any) => item?.seriesName === name)?.marker ?? ""
        );
        return tooltipText(chart, plot, items[0]?.dataIndex ?? -1, markers);
      },
    },
  };
}

export interface TdChartsState {
  open: ReadonlySet<TdChartKey>;
  onToggle: (_key: TdChartKey) => void;
  granularity: ChartGranularity;
}

export function tileToggle(
  charts: TdChartsState,
  key: TdChartKey
): TileToggleProps {
  return {
    selected: charts.open.has(key),
    onToggle: () => charts.onToggle(key),
    controlsId: chartElementId(key),
  };
}

const BUCKETS_NOTE =
  "Each bucket is a UTC day, or an ISO week labelled by its Monday. A faded " +
  "point or bar covers only part of its bucket; hover it for the span.";

export function TdGranularityControl({
  value,
  onChange,
}: {
  value: ChartGranularity;
  onChange: (_value: ChartGranularity) => void;
}) {
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Typography variant="body2" color="text.secondary">
        Chart buckets
      </Typography>
      <InfoTooltip label="Chart buckets" paragraphs={[BUCKETS_NOTE]} />
      <ToggleButtonGroup
        exclusive
        size="small"
        value={value}
        aria-label="Chart bucket size"
        onChange={(_event, next: ChartGranularity | null) => {
          if (next !== null) {
            onChange(next);
          }
        }}
      >
        {CHART_GRANULARITY_OPTIONS.map((option) => (
          <ToggleButton key={option.value} value={option.value}>
            {option.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Stack>
  );
}

export interface TdChartSource {
  loading: boolean;
  error?: string;
  rows: any[];
  window: PlotWindow;
  note?: string;
}

function TdChart({
  chartKey,
  source,
  granularity,
}: {
  chartKey: TdChartKey;
  source: TdChartSource;
  granularity: ChartGranularity;
}) {
  const chart = TD_CHARTS[chartKey];
  const plot = useMemo(
    () => buildPlot(chart, source.rows, granularity, source.window),
    [chart, source.rows, granularity, source.window]
  );
  const axis = UNIT_AXIS[chart.unit];
  const notes = [chart.note, source.note].filter((note) => note !== undefined);
  return (
    <Grid size={{ xs: 12 }}>
      <Box id={chartElementId(chartKey)}>
        <TdPanel
          title={chart.title}
          height={CHART_HEIGHT}
          loading={source.loading}
          error={source.error}
          emptyText={
            plot.buckets.length === 0 ? "No days to chart." : undefined
          }
        >
          <Box sx={{ height: CHART_HEIGHT }}>
            <TimeSeriesPanelWithData
              data={[]}
              series={plotSeries(chart, plot)}
              title={chart.title}
              groupByFieldName="series"
              legendPadding={220}
              timeFieldDisplayFormat="YYYY-MM-DD"
              yAxisLabel={axis.label}
              yAxisRenderer={axis.tick}
              additionalOptions={plotOptions(chart, plot)}
              useUTC={true}
            />
          </Box>
        </TdPanel>
        {notes.length > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {notes.join(" ")}
          </Typography>
        )}
      </Box>
    </Grid>
  );
}

// The open charts of one section, in the order of its tiles, below them.
export function TdCharts({
  charts,
  keys,
  sources,
}: {
  charts: TdChartsState;
  keys: TdChartKey[];
  sources: Partial<Record<TdSource, TdChartSource>>;
}) {
  return (
    <>
      {keys
        .filter((key) => charts.open.has(key))
        .map((key) => {
          const source = sources[TD_CHARTS[key].source];
          return source === undefined ? null : (
            <TdChart
              key={key}
              chartKey={key}
              source={source}
              granularity={charts.granularity}
            />
          );
        })}
    </>
  );
}
