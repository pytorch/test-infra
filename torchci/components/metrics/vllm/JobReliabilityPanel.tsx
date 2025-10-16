import { EChartsOption } from "echarts";
import { useDarkMode } from "lib/DarkModeContext";
import { ChartPaper } from "./chartUtils";
import {
  COLOR_BG_DARK,
  COLOR_BORDER_LIGHT,
  COLOR_ERROR,
  COLOR_GRAY,
  COLOR_SUCCESS,
  COLOR_WARNING,
} from "./constants";

// Helper function to format stacked bar tooltip
function formatJobReliabilityTooltip(params: any, sortedData: any[]): string {
  if (!params || params.length === 0) return "";

  // Get the job index from the first param
  const jobIndex = params[0].dataIndex;
  const jobData = sortedData[jobIndex];
  if (!jobData) return "";

  const passed = jobData.passed_count || 0;
  const softFailed = jobData.soft_failed_count || 0;
  const failed = jobData.failed_count || 0;
  const canceled = jobData.canceled_count || 0;
  const total = passed + softFailed + failed + canceled;
  const successRate = jobData.success_rate
    ? (jobData.success_rate * 100).toFixed(1) + "%"
    : "N/A";

  return (
    `<b>${jobData.job_name}</b><br/>` +
    `Success Rate: <b>${successRate}</b><br/>` +
    `<br/>` +
    `✅ Passed: ${passed} (${
      total > 0 ? ((passed / total) * 100).toFixed(1) : 0
    }%)<br/>` +
    `⚠️  Soft Failures: ${softFailed} (${
      total > 0 ? ((softFailed / total) * 100).toFixed(1) : 0
    }%)<br/>` +
    `❌ Hard Failures: ${failed} (${
      total > 0 ? ((failed / total) * 100).toFixed(1) : 0
    }%)<br/>` +
    `⏸️  Canceled: ${canceled} (${
      total > 0 ? ((canceled / total) * 100).toFixed(1) : 0
    }%)<br/>` +
    `<br/>` +
    `Total Runs: ${total}`
  );
}

export default function JobReliabilityPanel({
  data,
}: {
  data: any[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  // Sort by total failure rate (hard + soft failures, highest first)
  const sortedData = [...(data || [])].sort((a, b) => {
    const hardFailedA = a.failed_count || 0;
    const softFailedA = a.soft_failed_count || 0;
    const nonCanceledA = a.non_canceled_count || 1;
    const totalFailureRateA = (hardFailedA + softFailedA) / nonCanceledA;

    const hardFailedB = b.failed_count || 0;
    const softFailedB = b.soft_failed_count || 0;
    const nonCanceledB = b.non_canceled_count || 1;
    const totalFailureRateB = (hardFailedB + softFailedB) / nonCanceledB;

    return totalFailureRateB - totalFailureRateA; // Descending (worst first)
  });

  const jobNames = sortedData.map((d) => d.job_name);

  // Calculate percentages for normalized stacked bars (0-100%)
  const passedPercents = sortedData.map((d) => {
    const total =
      (d.passed_count || 0) +
      (d.soft_failed_count || 0) +
      (d.failed_count || 0) +
      (d.canceled_count || 0);
    return total > 0 ? ((d.passed_count || 0) / total) * 100 : 0;
  });
  const softFailedPercents = sortedData.map((d) => {
    const total =
      (d.passed_count || 0) +
      (d.soft_failed_count || 0) +
      (d.failed_count || 0) +
      (d.canceled_count || 0);
    return total > 0 ? ((d.soft_failed_count || 0) / total) * 100 : 0;
  });
  const hardFailedPercents = sortedData.map((d) => {
    const total =
      (d.passed_count || 0) +
      (d.soft_failed_count || 0) +
      (d.failed_count || 0) +
      (d.canceled_count || 0);
    return total > 0 ? ((d.failed_count || 0) / total) * 100 : 0;
  });
  const canceledPercents = sortedData.map((d) => {
    const total =
      (d.passed_count || 0) +
      (d.soft_failed_count || 0) +
      (d.failed_count || 0) +
      (d.canceled_count || 0);
    return total > 0 ? ((d.canceled_count || 0) / total) * 100 : 0;
  });

  const options: EChartsOption = {
    title: {
      text: "Per-Job Reliability Breakdown (Main Branch)",
      subtext:
        "Sorted by total failure rate (hard + soft, worst first, min 3 runs)",
    },
    legend: {
      top: 40,
      data: ["Passed", "Soft Failures", "Hard Failures", "Canceled"],
    },
    grid: {
      top: 80,
      right: 60,
      bottom: 24,
      left: 40,
      containLabel: true,
    },
    xAxis: {
      type: "value",
      name: "Percentage",
      min: 0,
      max: 100,
      axisLabel: {
        formatter: (value: number) => value.toFixed(0) + "%",
      },
    },
    yAxis: {
      type: "category",
      data: jobNames,
      axisLabel: {
        interval: 0,
        fontSize: 10,
      },
      inverse: true, // Worst jobs at top
    },
    series: [
      {
        name: "Passed",
        type: "bar",
        stack: "total",
        data: passedPercents,
        itemStyle: { color: COLOR_SUCCESS },
        emphasis: { focus: "series" },
      },
      {
        name: "Soft Failures",
        type: "bar",
        stack: "total",
        data: softFailedPercents,
        itemStyle: { color: COLOR_WARNING },
        emphasis: { focus: "series" },
      },
      {
        name: "Hard Failures",
        type: "bar",
        stack: "total",
        data: hardFailedPercents,
        itemStyle: { color: COLOR_ERROR },
        emphasis: { focus: "series" },
      },
      {
        name: "Canceled",
        type: "bar",
        stack: "total",
        data: canceledPercents,
        itemStyle: { color: COLOR_GRAY },
        emphasis: { focus: "series" },
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
    <ChartPaper
      tooltip="Per-job reliability breakdown for main branch CI. Each horizontal bar shows: Green = clean passes, Orange = soft failures (flaky tests), Red = hard test failures. Sorted by total failure rate (worst jobs at top)."
      option={options}
      darkMode={darkMode}
    />
  );
}
