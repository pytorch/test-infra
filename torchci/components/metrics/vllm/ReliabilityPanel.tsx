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

// Helper function to generate stacked bar series for reliability data
function getReliabilityBarSeries(): any[] {
  return [
    {
      name: "Passed",
      type: "bar",
      stack: "builds",
      encode: { x: "granularity_bucket", y: "passed_count" },
      itemStyle: { color: COLOR_SUCCESS },
      emphasis: {
        focus: "series",
      },
    },
    {
      name: "Failed",
      type: "bar",
      stack: "builds",
      encode: { x: "granularity_bucket", y: "failed_count" },
      itemStyle: { color: COLOR_ERROR },
      emphasis: {
        focus: "series",
      },
    },
    {
      name: "Canceled",
      type: "bar",
      stack: "builds",
      encode: { x: "granularity_bucket", y: "canceled_count" },
      itemStyle: { color: COLOR_GRAY },
      emphasis: {
        focus: "series",
      },
    },
  ];
}

// Helper function to format reliability tooltip
function formatReliabilityTooltip(params: any): string {
  const data = params[0]?.data;
  if (!data) return "";

  const successRate = data.success_rate
    ? (data.success_rate * 100).toFixed(1) + "%"
    : "N/A";
  const passed = data.passed_count || 0;
  const failed = data.failed_count || 0;
  const canceled = data.canceled_count || 0;
  const total = data.total_count || 0;
  const nonCanceled = data.non_canceled_count || 0;

  return (
    `<b>${data.granularity_bucket}</b><br/>` +
    `Success Rate: <b>${successRate}</b><br/>` +
    `Passed: ${passed}<br/>` +
    `Failed: ${failed}<br/>` +
    `Canceled: ${canceled}<br/>` +
    `Non-canceled: ${nonCanceled}<br/>` +
    `Total: ${total}`
  );
}

export default function ReliabilityPanel({
  data,
}: {
  data: any[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  const options: EChartsOption = {
    title: {
      text: "CI Build Counts",
      subtext: "Daily build breakdown",
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
    series: getReliabilityBarSeries(),
    tooltip: getCrosshairTooltipConfig(darkMode, formatReliabilityTooltip),
  };

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts {...getReactEChartsProps(darkMode)} option={options} />
    </Paper>
  );
}
