import { EChartsOption } from "echarts";
import { useDarkMode } from "lib/DarkModeContext";
import { ChartPaper } from "./chartUtils";
import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WARNING } from "./constants";

// Helper function to format merges tooltip
function formatMergesTooltip(params: any): string {
  const data = params[0].data;
  const forceMerges = data.manual_merged_with_failures_count || 0;
  const manualClean = data.manual_merged_clean_count || 0;
  const autoMerged = data.auto_merged_count || 0;
  const totalMerged = forceMerges + manualClean + autoMerged;

  const forcePct =
    totalMerged > 0 ? ((forceMerges / totalMerged) * 100).toFixed(1) : "0.0";
  const manualCleanPct =
    totalMerged > 0 ? ((manualClean / totalMerged) * 100).toFixed(1) : "0.0";
  const autoPct =
    totalMerged > 0 ? ((autoMerged / totalMerged) * 100).toFixed(1) : "0.0";

  return (
    `<b>${data.granularity_bucket}</b><br/><br/>` +
    `✅ Auto-merged: ${autoMerged} (${autoPct}%)<br/>` +
    `⚠️  Manual (clean): ${manualClean} (${manualCleanPct}%)<br/>` +
    `❌ Force merge: ${forceMerges} (${forcePct}%)<br/>` +
    `<span style="font-size:10px;color:#999">(force = manual merge with hard-failing tests)</span><br/>` +
    `<br/>Total merged: ${totalMerged}`
  );
}

export default function MergesPanel({ data }: { data: any }) {
  const { darkMode } = useDarkMode();

  // Process data to separate clean manual merges from force merges
  const processedData = (data || []).map((d: any) => ({
    ...d,
    manual_merged_clean_count:
      (d.manual_merged_count || 0) - (d.manual_merged_with_failures_count || 0),
  }));

  const options: EChartsOption = {
    title: { text: "Merged pull requests, by day", subtext: "" },
    grid: { top: 60, right: 8, bottom: 24, left: 36 },
    dataset: { source: processedData },
    xAxis: { type: "category" },
    yAxis: { type: "value" },
    series: [
      {
        name: "Auto-merged",
        type: "bar",
        stack: "all",
        encode: { x: "granularity_bucket", y: "auto_merged_count" },
        itemStyle: { color: COLOR_SUCCESS },
      },
      {
        name: "Manual (clean)",
        type: "bar",
        stack: "all",
        encode: { x: "granularity_bucket", y: "manual_merged_clean_count" },
        itemStyle: { color: COLOR_WARNING },
      },
      {
        name: "Force merge",
        type: "bar",
        stack: "all",
        encode: {
          x: "granularity_bucket",
          y: "manual_merged_with_failures_count",
        },
        itemStyle: { color: COLOR_ERROR },
      },
    ],
    legend: {
      top: 24,
      data: ["Auto-merged", "Manual (clean)", "Force merge"],
    },
    tooltip: {
      trigger: "axis",
      formatter: formatMergesTooltip,
    },
  };

  return (
    <ChartPaper
      tooltip="Daily stacked bar showing how PRs were merged. Green = auto-merged (GitHub auto-merge enabled, all tests passed), Orange = manual clean (human clicked merge, tests passed), Red = force merge (human merged with hard-failing tests)."
      option={options}
      darkMode={darkMode}
    />
  );
}
