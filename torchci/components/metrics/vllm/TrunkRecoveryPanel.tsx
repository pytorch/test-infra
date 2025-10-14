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
    `Broke at: ${breakTime}<br/>` +
    `Stayed broken for: <b>${hours.toFixed(1)} hours</b>`
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
      "Trunk Breakage Duration",
      hasRecentData
        ? "How long trunk stayed broken before fix"
        : "How long trunk stayed broken (⚠️ No recent fixes)"
    ),
    grid: GRID_DEFAULT,
    xAxis: {
      type: "time",
      name: "When Trunk Broke",
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
      name: "Hours Broken",
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
          ? "Scatter plot showing how long trunk stayed broken each time it broke. Each point = one break→fix cycle. Y-axis = total hours from when trunk broke until it was fixed. Lower points = faster fixes."
          : "Scatter plot showing trunk breakage duration. Shows completed fix cycles only. ⚠️ Warning: If no points appear in recent days, trunk may be currently broken without a fix."
      }
      option={options}
      darkMode={darkMode}
    />
  );
}
