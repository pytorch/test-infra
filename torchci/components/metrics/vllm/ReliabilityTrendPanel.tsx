import { Paper } from "@mui/material";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import {
  getCrosshairTooltipConfig,
  getReactEChartsProps,
  GRID_DEFAULT,
} from "./chartUtils";
import { COLOR_ERROR, COLOR_GRAY, COLOR_SUCCESS } from "./constants";

// Helper function to generate line series for reliability trends
function getReliabilityLineSeries(): any[] {
  return [
    {
      name: "Passed",
      type: "line",
      encode: { x: "granularity_bucket", y: "passed_count" },
      smooth: true,
      lineStyle: { color: COLOR_SUCCESS, width: 2 },
      itemStyle: { color: COLOR_SUCCESS },
      symbolSize: 6,
      emphasis: {
        focus: "series",
      },
    },
    {
      name: "Failed",
      type: "line",
      encode: { x: "granularity_bucket", y: "failed_count" },
      smooth: true,
      lineStyle: { color: COLOR_ERROR, width: 2 },
      itemStyle: { color: COLOR_ERROR },
      symbolSize: 6,
      emphasis: {
        focus: "series",
      },
    },
    {
      name: "Canceled",
      type: "line",
      encode: { x: "granularity_bucket", y: "canceled_count" },
      smooth: true,
      lineStyle: { color: COLOR_GRAY, width: 2 },
      itemStyle: { color: COLOR_GRAY },
      symbolSize: 6,
      emphasis: {
        focus: "series",
      },
    },
  ];
}

// Helper function to format reliability trend tooltip
function formatReliabilityTrendTooltip(params: any): string {
  const data = params[0]?.data;
  if (!data) return "";

  const passed = data.passed_count || 0;
  const failed = data.failed_count || 0;
  const canceled = data.canceled_count || 0;
  const total = data.total_count || 0;
  const nonCanceled = data.non_canceled_count || 0;
  const successRate = data.success_rate
    ? (data.success_rate * 100).toFixed(1) + "%"
    : "N/A";

  return (
    `<b>${data.granularity_bucket}</b><br/>` +
    `Passed: ${passed} (incl. soft failures)<br/>` +
    `Failed: ${failed} (hard failures only)<br/>` +
    `Canceled: ${canceled}<br/>` +
    `Non-canceled: ${nonCanceled}<br/>` +
    `Total: ${total}<br/>` +
    `Success Rate: <b>${successRate}</b>`
  );
}

export default function ReliabilityTrendPanel({
  data,
}: {
  data: any[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  const options: EChartsOption = {
    title: {
      text: "CI Reliability Trends",
      subtext: "Daily success rate over time",
    },
    legend: {
      top: 24,
      data: ["Passed", "Failed", "Canceled"],
    },
    grid: { ...GRID_DEFAULT, bottom: 24 },
    dataset: { source: data || [] },
    xAxis: { type: "category" },
    yAxis: {
      type: "value",
      name: "Count",
      position: "left",
      axisLabel: {
        formatter: "{value}",
      },
    },
    series: getReliabilityLineSeries(),
    tooltip: getCrosshairTooltipConfig(darkMode, formatReliabilityTrendTooltip),
  };

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts {...getReactEChartsProps(darkMode)} option={options} />
    </Paper>
  );
}
