import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import { useDarkMode } from "lib/DarkModeContext";
import _ from "lodash";
import { ChartPaper } from "./chartUtils";
import {
  COLOR_ERROR,
  COLOR_GRAY,
  COLOR_MIXED_LINE,
  COLOR_SUCCESS,
  COLOR_SUCCESS_LINE,
} from "./constants";

// Helper function to handle build click events
function handleBuildClick(params: any) {
  if (params?.seriesType === "scatter") {
    const buildNumber = params?.data?.build_number;
    if (buildNumber !== undefined && buildNumber !== null) {
      const url = `https://buildkite.com/vllm/ci/builds/${buildNumber}/`;
      if (typeof window !== "undefined") {
        window.open(url, "_blank");
      }
    }
  }
}

// Helper function to generate main CI builds scatter series
function getMainScatterSeries(): any {
  return {
    name: "CI builds",
    type: "scatter",
    encode: { x: "started_at", y: "duration_hours" },
    symbolSize: 6,
    datasetIndex: 0,
    itemStyle: {
      color: (params: any) => {
        const s = params.data?.build_state?.toLowerCase?.();
        if (s === "failed") return COLOR_ERROR;
        if (s === "canceled" || s === "cancelled") return COLOR_GRAY;
        if (s === "passed" || s === "finished" || s === "success")
          return COLOR_SUCCESS;
        return COLOR_SUCCESS;
      },
    },
  };
}

// Helper function to generate line series for daily averages
function getLineSeries(
  dailyMeanSuccess: any[],
  dailyMeanNonCanceled: any[]
): any[] {
  return [
    {
      name: "Daily mean (success)",
      type: "line",
      datasetIndex: 1,
      smooth: true,
      encode: { x: "day", y: "value" },
      lineStyle: { color: COLOR_SUCCESS_LINE, opacity: 0.7, width: 1 },
      showSymbol: true,
      symbolSize: 4,
    },
    {
      name: "Daily mean (success+failed)",
      type: "line",
      datasetIndex: 2,
      smooth: true,
      encode: { x: "day", y: "value" },
      lineStyle: { color: COLOR_MIXED_LINE, opacity: 0.7, width: 1 },
      showSymbol: true,
      symbolSize: 4,
    },
  ];
}

// Helper function to generate scatter series for legend
function getLegendScatterSeries(): any[] {
  return [
    {
      name: "Success",
      type: "scatter",
      data: [],
      itemStyle: { color: COLOR_SUCCESS },
      tooltip: { show: false },
      silent: true,
    },
    {
      name: "Failed",
      type: "scatter",
      data: [],
      itemStyle: { color: COLOR_ERROR },
      tooltip: { show: false },
      silent: true,
    },
    {
      name: "Canceled",
      type: "scatter",
      data: [],
      itemStyle: { color: COLOR_GRAY },
      tooltip: { show: false },
      silent: true,
    },
  ];
}

// Helper function to format tooltip content
function formatTooltip(params: any): string {
  if (params.seriesType === "line") {
    const rawVal = Array.isArray(params.value)
      ? params.value[1]
      : params.data?.value;
    return `Day: ${params.data.day}<br/>Daily median: ${rawVal} h`;
  }
  const d = params.data;
  const when = d.started_at ? dayjs(d.started_at).format("M/D/YY h:mm A") : "";
  return `Started: ${when}<br/>Pipeline: ${d.pipeline_name}<br/>Build #: ${d.build_number}<br/>Duration: ${d.duration_hours} h`;
}

export default function CiDurationsPanel({
  data,
}: {
  data: any[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  const source = (data || []).map((d: any) => ({
    ...d,
    started_at: d.started_at ? dayjs(d.started_at).toISOString() : null,
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
    title: {
      text: "CI run duration (hours) - Main Branch",
      subtext: "Buildkite builds",
    },
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
    grid: { top: 60, right: 8, bottom: 80, left: 64 },
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
      formatter: formatTooltip,
    },
    series: [
      getMainScatterSeries(),
      ...getLineSeries(dailyMeanSuccess, dailyMeanNonCanceled),
      ...getLegendScatterSeries(),
    ],
    dataZoom: [
      {
        type: "slider",
        show: true,
        xAxisIndex: 0,
        bottom: 0,
        start: 0,
        end: 100,
        height: 25,
      },
      {
        type: "inside",
        xAxisIndex: 0,
        start: 0,
        end: 100,
      },
    ],
  };

  return (
    <ChartPaper
      tooltip="Main branch CI runtimes over time. Green line = mean runtime for successful builds, Pink line = mean including failures. Scatter points = individual builds (click to view in Buildkite). Use slider or scroll to zoom."
      option={options}
      onEvents={{
        click: handleBuildClick,
      }}
      darkMode={darkMode}
    />
  );
}
