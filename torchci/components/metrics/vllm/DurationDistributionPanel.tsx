import { Paper } from "@mui/material";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import {
  getChartTitle,
  getReactEChartsProps,
  GRID_DEFAULT,
} from "./chartUtils";
import { COLOR_ERROR, COLOR_GRAY, COLOR_SUCCESS } from "./constants";

// Helper function to create histogram bins
function createHistogramBins(
  durations: number[],
  binSize: number = 0.5
): { range: string; count: number; midpoint: number }[] {
  if (durations.length === 0) return [];

  const maxDuration = Math.max(...durations);
  const numBins = Math.ceil(maxDuration / binSize);
  const bins: { range: string; count: number; midpoint: number }[] = [];

  for (let i = 0; i < numBins; i++) {
    const start = i * binSize;
    const end = (i + 1) * binSize;
    const count = durations.filter((d) => d >= start && d < end).length;
    bins.push({
      range: `${start.toFixed(1)}-${end.toFixed(1)}h`,
      count,
      midpoint: (start + end) / 2,
    });
  }

  return bins;
}

// Helper function to format distribution tooltip
function formatDistributionTooltip(params: any): string {
  if (!Array.isArray(params)) params = [params];

  const range = params[0]?.name || "";
  let result = `<b>Duration: ${range}</b><br/>`;

  params.forEach((p: any) => {
    if (p.value !== undefined && p.value > 0) {
      result += `${p.marker} ${p.seriesName}: ${p.value} build(s)<br/>`;
    }
  });

  return result;
}

// Helper function to get distribution series
function getDistributionSeries(
  successBins: any[],
  failedBins: any[],
  canceledBins: any[]
): any[] {
  return [
    {
      name: "Success",
      type: "bar",
      data: successBins.map((b) => b.count),
      itemStyle: { color: COLOR_SUCCESS },
      emphasis: { focus: "series" },
    },
    {
      name: "Failed",
      type: "bar",
      data: failedBins.map((b) => b.count),
      itemStyle: { color: COLOR_ERROR },
      emphasis: { focus: "series" },
    },
    {
      name: "Canceled",
      type: "bar",
      data: canceledBins.map((b) => b.count),
      itemStyle: { color: COLOR_GRAY },
      emphasis: { focus: "series" },
    },
  ];
}

export default function DurationDistributionPanel({
  data,
}: {
  data: any[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  // Process data into duration buckets by status
  const source = (data || []).map((d: any) => ({
    duration: Number(d.duration_hours),
    status: (d.build_state || "").toLowerCase(),
  }));

  const successStates = new Set(["passed", "finished", "success"]);
  const canceledStates = new Set(["canceled", "cancelled"]);

  const successDurations = source
    .filter((s) => successStates.has(s.status) && Number.isFinite(s.duration))
    .map((s) => s.duration);

  const failedDurations = source
    .filter((s) => s.status === "failed" && Number.isFinite(s.duration))
    .map((s) => s.duration);

  const canceledDurations = source
    .filter((s) => canceledStates.has(s.status) && Number.isFinite(s.duration))
    .map((s) => s.duration);

  // Create histogram bins
  const binSize = 0.5; // 30 minute bins
  const successBins = createHistogramBins(successDurations, binSize);
  const failedBins = createHistogramBins(failedDurations, binSize);
  const canceledBins = createHistogramBins(canceledDurations, binSize);

  // Use the longest bin range for x-axis categories
  const allBins = [successBins, failedBins, canceledBins];
  const categories =
    allBins
      .reduce((a, b) => (a.length > b.length ? a : b), [])
      .map((b) => b.range) || [];

  const options: EChartsOption = {
    title: getChartTitle(
      "CI Duration Distribution",
      "Histogram by build outcome"
    ),
    legend: {
      top: 24,
      data: ["Success", "Failed", "Canceled"],
    },
    grid: GRID_DEFAULT,
    xAxis: {
      type: "category",
      data: categories,
      name: "Duration Range",
      nameLocation: "middle",
      nameGap: 40,
      axisLabel: {
        rotate: 45,
        fontSize: 10,
      },
    },
    yAxis: {
      type: "value",
      name: "Count",
      nameLocation: "middle",
      nameGap: 40,
    },
    series: getDistributionSeries(successBins, failedBins, canceledBins),
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: formatDistributionTooltip,
    },
  };

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts {...getReactEChartsProps(darkMode)} option={options} />
    </Paper>
  );
}
