// The ECharts option for one GreenLight Quality trend chart.

import { alpha, getOverlayAlpha, lighten, Theme } from "@mui/material/styles";
import {
  BarSeriesOption,
  EChartsOption,
  format,
  LineSeriesOption,
  YAXisComponentOption,
} from "echarts";
import {
  AxisRole,
  bucketSpan,
  bucketValueText,
  ChartBucket,
  ChartGranularity,
  ChartPlot,
  valueAxis,
} from "lib/greenlight/qualityCharts";
import { formatUtcSpan } from "lib/greenlight/qualityFigures";
import { ChartSeriesConfig, QualityChartConfig } from "./chartConfigs";
import { qualityColors } from "./tileColors";

// Fixed rather than fitted to the labels, with room for a right-hand axis on
// every chart, so that a bucket sits at the same x on every chart in the stack.
// Wide enough for "10,000", "100%" and "p50 (min)".
const GRID = { top: 56, right: 64, bottom: 40, left: 64 };

const PARTIAL_BAND_ALPHA = 0.08;
const GRIDLINE_ALPHA = 0.25;
const HIDDEN_SERIES_ALPHA = 0.3;

// Bars a line is drawn over are filled faintly, so the line stays legible where
// it crosses them.
const UNDERLAY_BAR_ALPHA = 0.35;

export const CHART_PAPER_ELEVATION = 3;

const BUCKET_WORD: Record<ChartGranularity, string> = {
  day: "daily",
  week: "weekly",
};

// What the chart is drawn on. In dark mode MUI lays a white overlay graded by
// elevation over the Paper, so the theme's paper colour alone is too dark.
function paperSurface(theme: Theme): string {
  return theme.palette.mode === "dark"
    ? lighten(
        theme.palette.background.paper,
        getOverlayAlpha(CHART_PAPER_ELEVATION)
      )
    : theme.palette.background.paper;
}

function seriesColor(series: ChartSeriesConfig, theme: Theme): string {
  if (series.color === "neutral") {
    return theme.palette.text.secondary;
  }
  if (series.lightHue && theme.palette.mode === "light") {
    return theme.palette.info.dark;
  }
  return qualityColors(theme)[series.color];
}

// A second cue beside colour for the bars stacked next to LAND. Painted in the
// shade furthest from the fills, which are dark in light mode and light in dark.
function decal(pattern: "stripes" | "dots", theme: Theme) {
  const color =
    theme.palette.mode === "dark"
      ? alpha(theme.palette.common.black, 0.5)
      : alpha(theme.palette.common.white, 0.6);
  return pattern === "stripes"
    ? { color, dashArrayX: [1, 0], dashArrayY: [3, 5], rotation: Math.PI / 4 }
    : {
        color,
        symbol: "circle",
        symbolSize: 0.8,
        dashArrayX: [
          [8, 8],
          [0, 8, 8, 0],
        ],
        dashArrayY: [6, 0],
      };
}

// Left then right, in the order the series first need them.
function axisRoles(chart: QualityChartConfig): AxisRole[] {
  const roles: AxisRole[] = [];
  for (const series of chart.series) {
    const role = valueAxis(series.value);
    if (!roles.includes(role)) {
      roles.push(role);
    }
  }
  return roles;
}

// Only the left axis draws gridlines. The theme's divider colour is as dark as
// the elevated Paper in dark mode, so theirs is taken from the text colour.
function yAxis(
  role: AxisRole,
  index: number,
  chart: QualityChartConfig,
  theme: Theme
): YAXisComponentOption {
  const secondary =
    index > 0
      ? { splitLine: { show: false } }
      : {
          splitLine: {
            lineStyle: {
              color: alpha(theme.palette.text.primary, GRIDLINE_ALPHA),
            },
          },
        };
  switch (role) {
    case "count":
      return {
        type: "value",
        name: chart.countAxisName,
        minInterval: 1,
        ...secondary,
      };
    case "share":
      return {
        type: "value",
        name: "%",
        min: 0,
        max: chart.shareMax,
        axisLabel: { formatter: "{value}%" },
        ...secondary,
      };
    case "minutes":
      return { type: "log", name: "p50 (min)", ...secondary };
  }
}

function seriesOption(
  series: ChartSeriesConfig,
  values: (number | null)[],
  color: string,
  roles: AxisRole[],
  linesOverBars: boolean,
  theme: Theme
): BarSeriesOption | LineSeriesOption {
  const role = valueAxis(series.value);
  if (role === "count") {
    return {
      type: "bar",
      name: series.name,
      stack: "counts",
      yAxisIndex: roles.indexOf(role),
      data: values,
      itemStyle: {
        color: linesOverBars ? alpha(color, UNDERLAY_BAR_ALPHA) : color,
        decal:
          series.pattern === undefined
            ? undefined
            : decal(series.pattern, theme),
      },
    };
  }
  // The two green figures on a tile differ only slightly in shade, so the
  // dashed one also takes a different marker. Over bars, each marker is ringed
  // in the Paper's colour to stand clear of the fill beneath it.
  return {
    type: "line",
    name: series.name,
    yAxisIndex: roles.indexOf(role),
    data: values,
    symbol: series.dashed ? "triangle" : "circle",
    symbolSize: 7,
    itemStyle: linesOverBars
      ? { color, borderColor: paperSurface(theme), borderWidth: 1.5 }
      : { color },
    lineStyle: { color, width: 2, type: series.dashed ? "dashed" : "solid" },
  };
}

// The partial buckets' bands, carried by a series of empty bars in the bars'
// own stack. ECharts spans a one-category mark area across the category only on
// a bar series, and only while every category has a tick. The carrier is
// appended even when no bucket is partial: the chart takes each new option by
// merging, and a merge keeps a series that a later option leaves out.
function partialBands(
  spine: ChartBucket[],
  roles: AxisRole[],
  theme: Theme
): BarSeriesOption {
  return {
    type: "bar",
    stack: "counts",
    yAxisIndex: Math.max(roles.indexOf("count"), 0),
    data: spine.map(() => null),
    silent: true,
    markArea: {
      silent: true,
      itemStyle: {
        color: alpha(theme.palette.text.primary, PARTIAL_BAND_ALPHA),
      },
      data: spine.flatMap((bucket, i) =>
        bucket.partial ? [[{ xAxis: i }, { xAxis: i }]] : []
      ),
    },
  };
}

// Lists only the series the legend leaves visible, which are the ones ECharts
// passes in; the band carrier sits past the chart's own series and is skipped.
function tooltipHtml(
  chart: QualityChartConfig,
  spine: ChartBucket[],
  plot: ChartPlot,
  colors: string[],
  params: any
): string {
  const shown: any[] = Array.isArray(params) ? params : [params];
  const index = shown[0]?.dataIndex;
  const bucket = spine[index];
  if (bucket === undefined) {
    return "";
  }
  const visible = new Set(shown.map((param) => param.seriesIndex));
  const input = plot.inputs[index];
  const header =
    `<strong>${bucketSpan(bucket)}</strong>` +
    (bucket.partial ? " · partial bucket" : "");
  const values = chart.series.flatMap((series, i) =>
    visible.has(i)
      ? [
          `${format.getTooltipMarker(colors[i])}${format.encodeHTML(
            series.name
          )}: <strong>${format.encodeHTML(
            bucketValueText(series.value, input, plot.values[i][index])
          )}</strong>`,
        ]
      : []
  );
  const details = (input === undefined ? [] : chart.details(input))
    .filter((line): line is string => line !== undefined && line !== "")
    .map((line) => format.encodeHTML(line));
  return [header, ...values, ...details].join("<br/>");
}

export function chartOption(
  chart: QualityChartConfig,
  spine: ChartBucket[],
  plot: ChartPlot,
  theme: Theme,
  granularity: ChartGranularity
): EChartsOption {
  const colors = chart.series.map((series) => seriesColor(series, theme));
  const roles = axisRoles(chart);
  const linesOverBars = roles.includes("count") && roles.length > 1;
  return {
    backgroundColor: "transparent",
    aria: {
      enabled: true,
      label: {
        description: `${chart.title}: ${spine.length} ${
          BUCKET_WORD[granularity]
        } buckets, ${formatUtcSpan(
          spine[0]?.start,
          spine[spine.length - 1]?.end
        )}.`,
      },
    },
    grid: GRID,
    legend: {
      type: "scroll",
      top: 0,
      data: chart.series.map((series) => series.name),
      inactiveColor: alpha(theme.palette.text.primary, HIDDEN_SERIES_ALPHA),
      pageIconColor: theme.palette.text.primary,
      pageIconInactiveColor: theme.palette.text.disabled,
      pageTextStyle: { color: theme.palette.text.secondary },
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.palette.background.paper,
      borderColor: theme.palette.divider,
      textStyle: { color: theme.palette.text.primary },
      axisPointer: { lineStyle: { color: theme.palette.text.secondary } },
      formatter: (params: any) =>
        tooltipHtml(chart, spine, plot, colors, params),
    },
    xAxis: {
      type: "category",
      name: "UTC",
      nameLocation: "middle",
      nameGap: 28,
      data: spine.map((bucket) => bucket.label),
      axisTick: { show: false, interval: 0 },
    },
    yAxis: roles.map((role, index) => yAxis(role, index, chart, theme)),
    series: [
      ...chart.series.map((series, i) =>
        seriesOption(
          series,
          plot.values[i],
          colors[i],
          roles,
          linesOverBars,
          theme
        )
      ),
      partialBands(spine, roles, theme),
    ],
  };
}
