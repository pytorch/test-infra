import { EChartsOption } from "echarts";
import { useDarkMode } from "lib/DarkModeContext";
import {
  ChartPaper,
  getCrosshairTooltipConfig,
  GRID_DEFAULT,
} from "./chartUtils";
import { COLOR_ERROR } from "./constants";

// Helper function to format tooltip
function formatTooltip(params: any): string {
  const data = params[0]?.data;
  if (!data) return "";

  const redPct = data.red_pct ? data.red_pct.toFixed(1) : "0.0";

  return (
    `<b>${data.day}</b><br/><br/>` +
    `Commits on Red: <b>${redPct}%</b><br/>` +
    `(${data.red_count} red / ${data.total_count} total builds)`
  );
}

export default function CommitsOnRedTrendPanel({
  data,
}: {
  data: any[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  // Process data to calculate daily red percentage
  const processedData = (data || []).map((d: any) => ({
    day: d.day,
    red_pct: d.total_count > 0 ? (d.red_count / d.total_count) * 100 : 0,
    red_count: d.red_count,
    total_count: d.total_count,
  }));

  const options: EChartsOption = {
    title: {
      text: "Commits on Red % Over Time",
      subtext: "Daily percentage of commits to broken trunk",
    },
    grid: { ...GRID_DEFAULT, bottom: 60 },
    dataset: { source: processedData },
    xAxis: {
      type: "category",
    },
    yAxis: {
      type: "value",
      name: "% on Red",
      min: 0,
      max: 100,
      axisLabel: {
        formatter: "{value}%",
      },
    },
    series: [
      {
        name: "% Commits on Red",
        type: "line",
        encode: { x: "day", y: "red_pct" },
        smooth: true,
        lineStyle: { color: COLOR_ERROR, width: 3 },
        itemStyle: { color: COLOR_ERROR },
        symbolSize: 8,
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(238, 102, 102, 0.3)" },
              { offset: 1, color: "rgba(238, 102, 102, 0.05)" },
            ],
          },
        },
      },
    ],
    tooltip: getCrosshairTooltipConfig(darkMode, formatTooltip),
  };

  return (
    <ChartPaper
      tooltip="Daily percentage of commits made to a broken trunk (builds ending red). Warning threshold: 10%+. Lower is better."
      option={options}
      darkMode={darkMode}
    />
  );
}
