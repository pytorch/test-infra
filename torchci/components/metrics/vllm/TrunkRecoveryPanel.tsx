import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import { useDarkMode } from "lib/DarkModeContext";
import { ChartPaper, getChartTitle, GRID_DEFAULT } from "./chartUtils";
import { COLOR_ERROR } from "./constants";

// Helper function to format recovery tooltip
function formatRecoveryTooltip(params: any): string {
  const data = params.data;
  if (!data) return "";

  const breakTime = dayjs(data[0]).format("M/D/YY h:mm A");
  const hours = data[1];

  return (
    `<b>Trunk Breakage</b><br/>` +
    `When: ${breakTime}<br/>` +
    `Recovery time: <b>${hours.toFixed(1)} hours</b>`
  );
}

// Helper function to get recovery time series
function getRecoveryTimeSeries(processedData: any[]): any {
  return {
    name: "Recovery Time",
    type: "line",
    data: processedData,
    smooth: false,
    lineStyle: {
      color: COLOR_ERROR,
      width: 2,
    },
    itemStyle: {
      color: COLOR_ERROR,
    },
    symbolSize: 8,
  };
}

export default function TrunkRecoveryPanel({
  data,
  startTime,
  stopTime,
}: {
  data: any[] | undefined;
  startTime?: Date;
  stopTime?: Date;
}) {
  const { darkMode } = useDarkMode();

  // Process data: [break_time, recovery_hours]
  const processedData = (data || []).map((d: any) => [
    dayjs(d.break_time).toDate(),
    Number(d.recovery_hours),
  ]);

  // Check if there's recent data (last 2 days)
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const hasRecentData = processedData.some(
    (d: any) => new Date(d[0]) > twoDaysAgo
  );

  const options: EChartsOption = {
    title: getChartTitle(
      "Main Branch Recovery Time",
      hasRecentData
        ? "Time to fix over time"
        : "Time to fix over time (⚠️ No recent recoveries)"
    ),
    grid: GRID_DEFAULT,
    xAxis: {
      type: "time",
      name: "When Main Broke",
      nameLocation: "middle",
      nameGap: 40,
      min: startTime,
      max: stopTime,
      axisLabel: {
        hideOverlap: true,
        formatter: (value: number) => dayjs(value).format("MMM D"),
      },
    },
    yAxis: {
      type: "value",
      name: "Recovery Time (hours)",
      nameLocation: "middle",
      nameGap: 40,
      min: 0,
    },
    series: getRecoveryTimeSeries(processedData),
    tooltip: {
      trigger: "item",
      formatter: formatRecoveryTooltip,
    },
  };

  return (
    <ChartPaper
      tooltip={
        hasRecentData
          ? "Scatter plot of trunk recovery times. Each point shows how long it took to fix main branch after it broke (from first failed CI run to first successful CI run). Lower points = faster recovery."
          : "Scatter plot of trunk recovery times. Shows completed recovery cycles only. ⚠️ Warning: If no points appear in recent days, trunk may be currently broken without recovery."
      }
      option={options}
      darkMode={darkMode}
    />
  );
}
