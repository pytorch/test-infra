import { EChartsOption } from "echarts";
import { useDarkMode } from "lib/DarkModeContext";
import {
  ChartPaper,
  getCrosshairTooltipConfig,
  GRID_DEFAULT,
} from "./chartUtils";
import { COLOR_SUCCESS } from "./constants";

// Helper function to format tooltip
function formatTooltip(params: any): string {
  const data = params[0]?.data;
  if (!data) return "";

  const healthPct = data.health_pct ? data.health_pct.toFixed(1) : "0.0";

  return (
    `<b>${data.day}</b><br/><br/>` +
    `Trunk Health: <b>${healthPct}%</b><br/>` +
    `(${data.green_count} green / ${data.total_count} total builds)`
  );
}

export default function TrunkHealthTrendPanel({
  data,
}: {
  data: any[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  // Process data to calculate daily health percentage
  const processedData = (data || []).map((d: any) => ({
    day: d.day,
    health_pct: d.total_count > 0 ? (d.green_count / d.total_count) * 100 : 0,
    green_count: d.green_count,
    total_count: d.total_count,
  }));

  const options: EChartsOption = {
    title: {
      text: "Trunk Health % Over Time",
      subtext: "Daily percentage of time trunk was green",
    },
    grid: { ...GRID_DEFAULT, bottom: 60 },
    dataset: { source: processedData },
    xAxis: {
      type: "category",
      encode: { x: "day" },
    },
    yAxis: {
      type: "value",
      name: "Health %",
      min: 0,
      max: 100,
      axisLabel: {
        formatter: "{value}%",
      },
    },
    series: [
      {
        name: "Trunk Health %",
        type: "line",
        encode: { x: "day", y: "health_pct" },
        smooth: true,
        lineStyle: { color: COLOR_SUCCESS, width: 3 },
        itemStyle: { color: COLOR_SUCCESS },
        symbolSize: 8,
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(59, 162, 114, 0.3)" },
              { offset: 1, color: "rgba(59, 162, 114, 0.05)" },
            ],
          },
        },
      },
    ],
    tooltip: getCrosshairTooltipConfig(darkMode, formatTooltip),
  };

  return (
    <ChartPaper
      tooltip="Daily trunk health percentage. Shows percentage of builds that ended green each day. Target: 90%+. Higher is better."
      option={options}
      darkMode={darkMode}
    />
  );
}
