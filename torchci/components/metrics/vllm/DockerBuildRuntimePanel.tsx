import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import { useDarkMode } from "lib/DarkModeContext";
import _ from "lodash";
import { ChartPaper } from "./chartUtils";
import { COLOR_SUCCESS, COLOR_WARNING } from "./constants";

interface DockerBuildData {
  timestamp: string;
  build_number: number;
  runtime_minutes: number;
}

// Helper function to format tooltip
function formatTooltip(params: any): string {
  if (!params || !params.data) return "";

  const data = params.data;
  
  // Handle both scatter (array) and line (object) series
  let timestamp, runtime, buildNumber;
  
  if (Array.isArray(data)) {
    timestamp = data[0];
    runtime = data[1];
    buildNumber = data[2];
  } else {
    // For line series (daily average)
    timestamp = data.day;
    runtime = data.value;
    buildNumber = null;
  }

  if (!timestamp || runtime === undefined) return "";

  const formattedTime = dayjs(timestamp).format("M/D/YY h:mm A");

  let result = buildNumber
    ? `<b>Build #${buildNumber}</b><br/>`
    : `<b>Daily Average</b><br/>`;
  result += `Time: ${formattedTime}<br/>`;
  result += `Runtime: <b>${runtime.toFixed(1)} min</b>`;

  return result;
}

// Helper function to handle click events
function handleBuildClick(params: any) {
  if (params?.componentType === "series") {
    const data = Array.isArray(params.data) ? params.data : [params.data];
    const buildNumber = data[2];
    if (buildNumber !== undefined && buildNumber !== null) {
      const url = `https://buildkite.com/vllm/ci/builds/${buildNumber}/`;
      if (typeof window !== "undefined") {
        window.open(url, "_blank");
      }
    }
  }
}

export default function DockerBuildRuntimePanel({
  data,
}: {
  data: DockerBuildData[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  // Process data for chart
  const chartData = (data || []).map((d) => [
    dayjs(d.timestamp).toISOString(),
    d.runtime_minutes,
    d.build_number,
  ]);

  // Calculate daily average for trend line
  const groupedByDay = _.groupBy(data || [], (d) =>
    dayjs(d.timestamp).format("YYYY-MM-DD")
  );

  const dailyAvg = Object.entries(groupedByDay)
    .map(([day, records]) => {
      const avgRuntime = _.meanBy(records, "runtime_minutes");
      return {
        day,
        value: Number(avgRuntime.toFixed(1)),
      };
    })
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  // Calculate statistics
  const runtimes = (data || []).map((d) => d.runtime_minutes);
  const avgRuntime = runtimes.length ? _.mean(runtimes).toFixed(1) : "N/A";
  const p90Runtime = runtimes.length
    ? runtimes.sort((a, b) => a - b)[
        Math.floor(runtimes.length * 0.9)
      ].toFixed(1)
    : "N/A";

  const options: EChartsOption = {
    title: {
      text: "Docker Build Image Runtime",
      subtext: `Avg: ${avgRuntime}m  |  P90: ${p90Runtime}m  |  Total builds: ${runtimes.length}`,
      textStyle: {
        fontSize: 14,
      },
    },
    legend: {
      top: 24,
      data: ["Individual Builds", "Daily Average"],
    },
    grid: { top: 60, right: 20, bottom: 80, left: 60 },
    dataset: [{ source: chartData }, { source: dailyAvg }],
    xAxis: {
      type: "time",
      axisLabel: {
        hideOverlap: true,
        formatter: (value: number) => dayjs(value).format("M/D"),
      },
    },
    yAxis: {
      type: "value",
      name: "Runtime (minutes)",
      nameLocation: "middle",
      nameGap: 45,
      nameRotate: 90,
      axisLabel: {
        formatter: (value: number) => `${value}m`,
      },
    },
    series: [
      {
        name: "Individual Builds",
        type: "scatter",
        datasetIndex: 0,
        symbolSize: 6,
        itemStyle: { color: COLOR_SUCCESS, opacity: 0.6 },
      },
      {
        name: "Daily Average",
        type: "line",
        datasetIndex: 1,
        smooth: true,
        encode: { x: "day", y: "value" },
        lineStyle: { color: COLOR_WARNING, width: 2 },
        itemStyle: { color: COLOR_WARNING },
        showSymbol: true,
        symbolSize: 4,
      },
    ],
    tooltip: {
      trigger: "item",
      formatter: formatTooltip,
    },
  };

  return (
    <ChartPaper
      tooltip="Docker build image runtime over time. Each point is an individual build (click to open in Buildkite). Green line shows daily average trend."
      option={options}
      onEvents={{ click: handleBuildClick }}
      darkMode={darkMode}
    />
  );
}

