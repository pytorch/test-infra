import { Paper } from "@mui/material";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WARNING } from "./constants";

export default function MergesPanel({ data }: { data: any }) {
  const { darkMode } = useDarkMode();

  const options: EChartsOption = {
    title: { text: "Merged pull requests, by day", subtext: "" },
    grid: { top: 60, right: 8, bottom: 24, left: 36 },
    dataset: { source: data },
    xAxis: { type: "category" },
    yAxis: { type: "value" },
    series: [
      {
        type: "bar",
        stack: "all",
        encode: { x: "granularity_bucket", y: "auto_merged_count" },
      },
      {
        type: "bar",
        stack: "all",
        encode: { x: "granularity_bucket", y: "manual_merged_count" },
      },
      {
        type: "bar",
        stack: "all",
        encode: {
          x: "granularity_bucket",
          y: "manual_merged_with_failures_count",
        },
      },
    ],
    color: [COLOR_SUCCESS, COLOR_WARNING, COLOR_ERROR],
    tooltip: {
      trigger: "axis",
      formatter: (params: any) => {
        const manualMergedFailures =
          params[0].data.manual_merged_with_failures_count;
        const manualMerged = params[0].data.manual_merged_count;
        const autoMerged = params[0].data.auto_merged_count;
        const total = manualMergedFailures + manualMerged + autoMerged;
        const manualMergedFailuresPct =
          ((manualMergedFailures / total) * 100).toFixed(1) + "%";
        const manualMergedPct = ((manualMerged / total) * 100).toFixed(1) + "%";
        const autoMergedPct = ((autoMerged / total) * 100).toFixed(1) + "%";
        return (
          `Force merges (red): ${manualMergedFailures} (${manualMergedFailuresPct})` +
          `<br/>Manual merges (orange): ${manualMerged} (${manualMergedPct})` +
          `<br/>Auto merges (green): ${autoMerged} (${autoMergedPct})` +
          `<br/>Total: ${total}`
        );
      },
    },
  };

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts
        theme={darkMode ? "dark-hud" : undefined}
        style={{ height: "100%", width: "100%" }}
        option={options}
      />
    </Paper>
  );
}
