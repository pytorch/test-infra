import { EChartsOption } from "echarts";
import { useDarkMode } from "lib/DarkModeContext";
import {
  ChartPaper,
  getCrosshairTooltipConfig,
  GRID_DEFAULT,
} from "./chartUtils";
import { COLOR_SUCCESS } from "./constants";

// Helper function to generate area series for reliability trends
function getReliabilityAreaSeries(): any[] {
  return [
    {
      name: "Success Rate",
      type: "line",
      encode: { x: "granularity_bucket", y: "success_rate_pct" },
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
  ];
}

// Helper function to format reliability trend tooltip
function formatReliabilityTrendTooltip(params: any): string {
  const data = params[0]?.data;
  if (!data) return "";

  const passed = data.passed_count || 0;
  const failed = data.failed_count || 0;
  const canceled = data.canceled_count || 0;
  const successRate = data.success_rate
    ? (data.success_rate * 100).toFixed(1) + "%"
    : "N/A";

  return (
    `<b>${data.granularity_bucket}</b><br/><br/>` +
    `<b style="font-size:1.2em">Success Rate: ${successRate}</b><br/><br/>` +
    `✅ Passed: ${passed} builds<br/>` +
    `❌ Failed: ${failed} builds (hard failures)<br/>` +
    `⏸️  Canceled: ${canceled} builds`
  );
}

export default function ReliabilityTrendPanel({
  data,
}: {
  data: any[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  // Add computed percentage field to data
  const processedData = (data || []).map((d: any) => ({
    ...d,
    success_rate_pct: d.success_rate ? d.success_rate * 100 : 0,
  }));

  const options: EChartsOption = {
    title: {
      text: "CI Success Rate Trend (Main Branch)",
      subtext: "Daily success rate percentage",
    },
    legend: {
      top: 24,
      data: ["Success Rate"],
    },
    grid: { ...GRID_DEFAULT, bottom: 24 },
    dataset: { source: processedData },
    xAxis: { type: "category" },
    yAxis: {
      type: "value",
      name: "Success Rate (%)",
      position: "left",
      min: 0,
      max: 100,
      axisLabel: {
        formatter: "{value}%",
      },
    },
    series: getReliabilityAreaSeries(),
    tooltip: getCrosshairTooltipConfig(darkMode, formatReliabilityTrendTooltip),
  };

  return (
    <ChartPaper
      tooltip="Daily success rate trend for main branch CI. Shows percentage of builds with zero hard failures (soft failures count as success). Orange dashed line shows 85% target."
      option={options}
      darkMode={darkMode}
    />
  );
}
