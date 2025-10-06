import { Paper } from "@mui/material";
import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import {
  getChartTitle,
  getReactEChartsProps,
  GRID_DEFAULT,
} from "./chartUtils";
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
}: {
  data: any[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  // Process data: [break_time, recovery_hours]
  const processedData = (data || []).map((d: any) => [
    dayjs(d.break_time).toDate(),
    Number(d.recovery_hours),
  ]);

  const options: EChartsOption = {
    title: getChartTitle("Main Branch Recovery Time", "Time to fix over time"),
    grid: GRID_DEFAULT,
    xAxis: {
      type: "time",
      name: "When Main Broke",
      nameLocation: "middle",
      nameGap: 40,
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
    },
    series: getRecoveryTimeSeries(processedData),
    tooltip: {
      trigger: "item",
      formatter: formatRecoveryTooltip,
    },
  };

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts {...getReactEChartsProps(darkMode)} option={options} />
    </Paper>
  );
}
