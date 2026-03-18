import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import { useDarkMode } from "lib/DarkModeContext";
import _ from "lodash";
import {
  ChartPaper,
  getCrosshairTooltipConfig,
  GRID_DEFAULT,
} from "./chartUtils";
import { COLOR_SUCCESS, COLOR_WARNING } from "./constants";

// Helper function to format tooltip
function formatTooltip(params: any): string {
  const data = params[0]?.data;
  if (!data) return "";

  const p50 = data.p50 ? data.p50.toFixed(2) : "N/A";
  const p90 = data.p90 ? data.p90.toFixed(2) : "N/A";

  return (
    `<b>${data.day}</b><br/><br/>` +
    `P50: <b>${p50}h</b><br/>` +
    `P90: <b>${p90}h</b><br/>` +
    `${data.count} successful builds`
  );
}

export default function TimeToSignalTrendPanel({
  data,
}: {
  data: any[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  // Group by day and calculate P50/P90 for each day
  const points = (data || []).filter((d: any) => {
    const state = String(d.build_state || "").toLowerCase();
    return ["passed", "finished", "success"].includes(state);
  });

  const byDay = _.groupBy(points, (d: any) => {
    if (!d.started_at) return "";
    return dayjs(d.started_at).format("YYYY-MM-DD");
  });

  const dailyData = Object.entries(byDay)
    .map(([day, builds]) => {
      const durations = builds
        .map((b: any) => Number(b.duration_hours))
        .filter((x: number) => Number.isFinite(x))
        .sort((a: number, b: number) => a - b);

      if (durations.length === 0) return null;

      const p50 = durations[Math.floor((durations.length - 1) * 0.5)];
      const p90 = durations[Math.floor((durations.length - 1) * 0.9)];

      return {
        day,
        p50,
        p90,
        count: durations.length,
      };
    })
    .filter((d) => d !== null)
    .sort((a, b) => (a!.day || "").localeCompare(b!.day || ""));

  const options: EChartsOption = {
    title: {
      text: "Time to Signal Trend",
      subtext: "Daily CI runtime (P50/P90)",
    },
    legend: {
      top: 24,
      data: ["P50", "P90"],
    },
    grid: { ...GRID_DEFAULT, bottom: 60 },
    dataset: { source: dailyData },
    xAxis: {
      type: "category",
    },
    yAxis: {
      type: "value",
      name: "Hours",
      min: 0,
      axisLabel: {
        formatter: "{value}h",
      },
    },
    series: [
      {
        name: "P50",
        type: "line",
        encode: { x: "day", y: "p50" },
        smooth: true,
        lineStyle: { color: COLOR_SUCCESS, width: 2 },
        itemStyle: { color: COLOR_SUCCESS },
        symbolSize: 6,
      },
      {
        name: "P90",
        type: "line",
        encode: { x: "day", y: "p90" },
        smooth: true,
        lineStyle: { color: COLOR_WARNING, width: 2, type: "dashed" },
        itemStyle: { color: COLOR_WARNING },
        symbolSize: 6,
      },
    ],
    tooltip: getCrosshairTooltipConfig(darkMode, formatTooltip),
  };

  return (
    <ChartPaper
      tooltip="Daily trend of CI runtime (time to signal). Shows P50 (median) and P90 (90th percentile) of successful build durations per day. Lower is better."
      option={options}
      darkMode={darkMode}
    />
  );
}
