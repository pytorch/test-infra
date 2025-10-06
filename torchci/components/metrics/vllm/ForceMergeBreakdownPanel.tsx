import { Paper } from "@mui/material";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import _ from "lodash";
import { getReactEChartsProps } from "./chartUtils";
import { COLOR_BORDER_WHITE, COLOR_ERROR, COLOR_WARNING } from "./constants";

// Helper function to format breakdown tooltip
function formatBreakdownTooltip(params: any): string {
  const name = params.name;
  const value = params.value;
  const percent = params.percent;

  return `<b>${name}</b><br/>Count: ${value}<br/>Percentage: ${percent.toFixed(
    1
  )}%`;
}

// Helper function to get pie series
function getPieSeries(data: any[]): any {
  return {
    name: "Force Merge Reason",
    type: "pie",
    radius: ["40%", "70%"],
    avoidLabelOverlap: true,
    itemStyle: {
      borderRadius: 10,
      borderColor: COLOR_BORDER_WHITE,
      borderWidth: 2,
    },
    label: {
      show: true,
      formatter: "{b}: {d}%",
    },
    emphasis: {
      label: {
        show: true,
        fontSize: 16,
        fontWeight: "bold",
      },
    },
    data: data,
  };
}

export default function ForceMergeBreakdownPanel({
  data,
}: {
  data: any[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  // Sum up the counts across all time periods
  const manualMergedFailures =
    data === undefined || data.length === 0
      ? 0
      : _.sumBy(data, "manual_merged_with_failures_count");
  const manualMergedPending =
    data === undefined || data.length === 0
      ? 0
      : _.sumBy(data, "manual_merged_pending_count");

  const pieData = [
    {
      value: manualMergedFailures,
      name: "CI Failure (failing checks)",
      itemStyle: { color: COLOR_ERROR },
    },
    {
      value: manualMergedPending,
      name: "Impatience (checks pending)",
      itemStyle: { color: COLOR_WARNING },
    },
  ];

  const options: EChartsOption = {
    title: {
      text: "Force Merge Breakdown",
      subtext: "Reasons for manual merges",
    },
    tooltip: {
      trigger: "item",
      formatter: formatBreakdownTooltip,
    },
    legend: {
      orient: "vertical",
      left: "left",
      top: "middle",
    },
    series: getPieSeries(pieData),
  };

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts {...getReactEChartsProps(darkMode)} option={options} />
    </Paper>
  );
}
