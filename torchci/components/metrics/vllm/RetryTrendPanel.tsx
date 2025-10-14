import { EChartsOption } from "echarts";
import { useDarkMode } from "lib/DarkModeContext";
import {
  ChartPaper,
  getCrosshairTooltipConfig,
  GRID_DEFAULT,
} from "./chartUtils";
import { COLOR_WARNING } from "./constants";

// Helper function to format tooltip
function formatTooltip(params: any): string {
  const data = params[0]?.data;
  if (!data) return "";

  const retryRate = data.retry_rate
    ? (data.retry_rate * 100).toFixed(2) + "%"
    : "0.00%";

  return (
    `<b>${data.granularity_bucket}</b><br/><br/>` +
    `Retry Rate: <b>${retryRate}</b><br/>` +
    `${data.retried_count} retried jobs<br/>` +
    `${data.total_jobs} total jobs`
  );
}

export default function RetryTrendPanel({ data }: { data: any[] | undefined }) {
  const { darkMode } = useDarkMode();

  // Add computed percentage field to data
  const processedData = (data || []).map((d: any) => ({
    ...d,
    retry_rate_pct: d.retry_rate ? d.retry_rate * 100 : 0,
  }));

  const options: EChartsOption = {
    title: {
      text: "Job Retry Rate Trend",
      subtext: "Daily % of jobs that were retried",
    },
    grid: { ...GRID_DEFAULT, bottom: 60 },
    dataset: { source: processedData },
    xAxis: { type: "category" },
    yAxis: {
      type: "value",
      name: "Retry Rate (%)",
      min: 0,
      axisLabel: {
        formatter: "{value}%",
      },
    },
    series: [
      {
        name: "Retry Rate",
        type: "line",
        encode: { x: "granularity_bucket", y: "retry_rate_pct" },
        smooth: true,
        lineStyle: { color: COLOR_WARNING, width: 3 },
        itemStyle: { color: COLOR_WARNING },
        symbolSize: 8,
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(252, 148, 3, 0.3)" },
              { offset: 1, color: "rgba(252, 148, 3, 0.05)" },
            ],
          },
        },
      },
    ],
    tooltip: getCrosshairTooltipConfig(darkMode, formatTooltip),
  };

  return (
    <ChartPaper
      tooltip="Daily job retry rate. Shows percentage of jobs that were manually or automatically retried. Low values (<1%) indicate stable infrastructure. Spikes may indicate infrastructure issues."
      option={options}
      darkMode={darkMode}
    />
  );
}
