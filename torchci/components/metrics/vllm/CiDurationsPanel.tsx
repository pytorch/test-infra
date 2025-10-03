import { Paper } from "@mui/material";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import _ from "lodash";

export default function CiDurationsPanel({
  data,
}: {
  data: any[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  const source = (data || []).map((d: any) => ({
    ...d,
    started_at: d.started_at ? new Date(d.started_at).toISOString() : null,
    duration_hours: Number(d.duration_hours),
  }));
  const durations = source
    .map((s) => s.duration_hours)
    .filter((x) => Number.isFinite(x));
  const sorted = [...durations].sort((a, b) => a - b);
  const quantile = (p: number) =>
    sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : undefined;
  const p10 = quantile(0.1);
  const p50 = quantile(0.5);
  const p90 = quantile(0.9);

  const successStates = new Set(["passed", "finished", "success"]);
  const nonCanceled = source.filter((s: any) => {
    const st = (s.build_state || "").toLowerCase();
    return st !== "canceled" && st !== "cancelled";
  });
  const successOnly = source.filter((s: any) =>
    successStates.has((s.build_state || "").toLowerCase())
  );

  const groupDaily = (rows: any[]) => {
    const grouped = _.groupBy(rows, (s) =>
      s.started_at ? (s.started_at as string).slice(0, 10) : ""
    );
    return Object.entries(grouped)
      .filter(([k]) => k !== "")
      .map(([day, rs]: any) => {
        const vals = rs
          .map((r: any) => Number(r.duration_hours))
          .filter((x: number) => Number.isFinite(x));
        const value = vals.length ? _.sum(vals) / vals.length : undefined;
        return {
          day,
          value: value !== undefined ? Number(value.toFixed(3)) : undefined,
        };
      })
      .sort((a: any, b: any) => (a.day < b.day ? -1 : 1));
  };

  let dailyMeanSuccess = groupDaily(successOnly);
  const dailyMeanNonCanceled = groupDaily(nonCanceled);
  if (dailyMeanNonCanceled.length > 0 && dailyMeanSuccess.length > 0) {
    const lastDay = dailyMeanNonCanceled[dailyMeanNonCanceled.length - 1].day;
    const hasLastDay = dailyMeanSuccess.some((d: any) => d.day === lastDay);
    if (!hasLastDay) {
      const lastVal = dailyMeanSuccess[dailyMeanSuccess.length - 1].value;
      if (lastVal !== undefined) {
        dailyMeanSuccess = [
          ...dailyMeanSuccess,
          { day: lastDay, value: lastVal },
        ];
      }
    }
  }

  const options: EChartsOption = {
    title: { text: "CI run duration (hours)", subtext: "Buildkite builds" },
    legend: {
      top: 24,
      data: [
        { name: "Daily mean (success)" },
        { name: "Daily mean (success+failed)" },
        { name: "Success" },
        { name: "Failed" },
        { name: "Canceled" },
      ],
      selectedMode: false,
    },
    grid: { top: 60, right: 8, bottom: 24, left: 64 },
    dataset: [
      { source },
      { source: dailyMeanSuccess },
      { source: dailyMeanNonCanceled },
    ],
    xAxis: { type: "time", axisLabel: { hideOverlap: true } },
    yAxis: {
      type: "value",
      name: "hours",
      nameLocation: "middle",
      nameGap: 42,
      nameRotate: 90,
      axisLabel: { margin: 8 },
    },
    tooltip: {
      trigger: "item",
      formatter: (p: any) => {
        if (p.seriesType === "line") {
          const rawVal = Array.isArray(p.value) ? p.value[1] : p.data?.value;
          return `Day: ${p.data.day}<br/>Daily median: ${rawVal} h`;
        }
        const d = p.data;
        const when = d.started_at
          ? new Date(d.started_at).toLocaleString()
          : "";
        return `Started: ${when}<br/>Pipeline: ${d.pipeline_name}<br/>Build #: ${d.build_number}<br/>Duration: ${d.duration_hours} h`;
      },
    },
    series: [
      {
        name: "CI builds",
        type: "scatter",
        encode: { x: "started_at", y: "duration_hours" },
        symbolSize: 6,
        datasetIndex: 0,
        itemStyle: {
          color: (params: any) => {
            const s = params.data?.build_state?.toLowerCase?.();
            if (s === "failed") return "#ee6666"; // red
            if (s === "canceled" || s === "cancelled") return "#9e9e9e"; // gray
            if (s === "passed" || s === "finished" || s === "success")
              return "#3ba272"; // green
            return "#3ba272";
          },
        },
      },
      {
        name: "Daily mean (success)",
        type: "line",
        datasetIndex: 1,
        smooth: true,
        encode: { x: "day", y: "value" },
        lineStyle: { color: "#00E676", opacity: 0.7, width: 1 },
        showSymbol: true,
        symbolSize: 4,
      },
      {
        name: "Daily mean (success+failed)",
        type: "line",
        datasetIndex: 2,
        smooth: true,
        encode: { x: "day", y: "value" },
        lineStyle: { color: "#FF4081", opacity: 0.7, width: 1 },
        showSymbol: true,
        symbolSize: 4,
      },
      {
        name: "Success",
        type: "scatter",
        data: [],
        itemStyle: { color: "#3ba272" },
        tooltip: { show: false },
        silent: true,
      },
      {
        name: "Failed",
        type: "scatter",
        data: [],
        itemStyle: { color: "#ee6666" },
        tooltip: { show: false },
        silent: true,
      },
      {
        name: "Canceled",
        type: "scatter",
        data: [],
        itemStyle: { color: "#9e9e9e" },
        tooltip: { show: false },
        silent: true,
      },
    ],
  };

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <ReactECharts
        theme={darkMode ? "dark-hud" : undefined}
        style={{ height: "100%", width: "100%" }}
        option={options}
        onEvents={{
          click: (p: any) => {
            if (p?.seriesType === "scatter") {
              const num = p?.data?.build_number;
              if (num !== undefined && num !== null) {
                const url = `https://buildkite.com/vllm/ci/builds/${num}/`;
                if (typeof window !== "undefined") window.open(url, "_blank");
              }
            }
          },
        }}
      />
    </Paper>
  );
}
