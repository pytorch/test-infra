import { Paper } from "@mui/material";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import { getReactEChartsProps } from "./chartUtils";
import {
  COLOR_BG_DARK,
  COLOR_BORDER_LIGHT,
  COLOR_ERROR,
  COLOR_SUCCESS,
  COLOR_WARNING,
} from "./constants";

// Helper function to format success rate label
function formatSuccessRateLabel(params: any): string {
  const rate = params.value * 100;
  return rate.toFixed(1) + "%";
}

// Helper function to format job reliability tooltip
function formatJobReliabilityTooltip(params: any, sortedData: any[]): string {
  const param = params[0];
  const jobData = sortedData[param.dataIndex];
  if (!jobData) return "";

  const successRate = jobData.success_rate
    ? (jobData.success_rate * 100).toFixed(1) + "%"
    : "N/A";
  const passed = jobData.passed_count || 0;
  const failed = jobData.failed_count || 0;
  const canceled = jobData.canceled_count || 0;
  const total = jobData.total_count || 0;
  const nonCanceled = jobData.non_canceled_count || 0;

  return (
    `<b>${jobData.job_name}</b><br/>` +
    `Success Rate: <b>${successRate}</b><br/>` +
    `Passed: ${passed}<br/>` +
    `Failed: ${failed}<br/>` +
    `Canceled: ${canceled}<br/>` +
    `Non-canceled: ${nonCanceled}<br/>` +
    `Total: ${total}`
  );
}

export default function JobReliabilityPanel({
  data,
}: {
  data: any[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  // Sort by success rate (worst first) and prepare data
  const sortedData = [...(data || [])].sort((a, b) => {
    const rateA = a.success_rate ?? 0;
    const rateB = b.success_rate ?? 0;
    return rateA - rateB;
  });

  const jobNames = sortedData.map((d) => d.job_name);
  const successRates = sortedData.map((d) => d.success_rate ?? 0);

  // Color code by reliability: red (<70%), yellow (70-90%), green (>90%)
  const itemColors = successRates.map((rate) => {
    if (rate < 0.7) return COLOR_ERROR;
    if (rate < 0.9) return COLOR_WARNING;
    return COLOR_SUCCESS;
  });

  const options: EChartsOption = {
    title: {
      text: "Per-Job Reliability",
      subtext: "Success rate by job (min 3 runs)",
    },
    grid: {
      top: 60,
      right: 60,
      bottom: 24,
      left: 40,
      containLabel: true,
    },
    xAxis: {
      type: "value",
      name: "Success Rate",
      min: 0,
      max: 1,
      axisLabel: {
        formatter: (value: number) => (value * 100).toFixed(0) + "%",
      },
    },
    yAxis: {
      type: "category",
      data: jobNames,
      axisLabel: {
        interval: 0,
        fontSize: 10,
      },
      inverse: false, // Worst jobs at bottom
    },
    series: [
      {
        name: "Success Rate",
        type: "bar",
        data: successRates.map((rate, idx) => ({
          value: rate,
          itemStyle: { color: itemColors[idx] },
        })),
        label: {
          show: true,
          position: "right",
          formatter: formatSuccessRateLabel,
          fontSize: 9,
        },
      },
    ],
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "shadow",
      },
      formatter: (params: any) =>
        formatJobReliabilityTooltip(params, sortedData),
    },
    dataZoom: [
      {
        type: "slider",
        yAxisIndex: 0,
        show: true,
        right: 10,
        width: 30,
        start:
          jobNames.length > 15
            ? Math.max(0, 100 - (15 / jobNames.length) * 100)
            : 0,
        end: 100,
        handleSize: "100%",
        borderColor: darkMode ? COLOR_BG_DARK : COLOR_BORDER_LIGHT,
      },
    ],
  };

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts {...getReactEChartsProps(darkMode)} option={options} />
    </Paper>
  );
}
