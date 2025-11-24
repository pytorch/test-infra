import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import { useDarkMode } from "lib/DarkModeContext";
import _ from "lodash";
import {
  ChartPaper,
  getCrosshairTooltipConfig,
  GRID_DEFAULT,
} from "./chartUtils";
import { COLOR_SUCCESS, COLOR_ERROR, COLOR_WARNING } from "./constants";

interface TrunkHealthData {
  build_started_at: string;
  is_green: number;
}

// Helper function to calculate stability score for a window of days
function calculateStabilityScore(healthValues: number[]): number {
  if (healthValues.length === 0) return 0;

  // Calculate volatility (standard deviation)
  const mean = _.mean(healthValues);
  const squaredDiffs = healthValues.map((x) => Math.pow(x - mean, 2));
  const variance = _.mean(squaredDiffs);
  const volatility = Math.sqrt(variance);

  // Count state transitions
  const transitions = healthValues.reduce((count, current, index) => {
    if (index === 0) return 0;
    const previous = healthValues[index - 1];
    return current !== previous ? count + 1 : count;
  }, 0);

  // Calculate penalties
  const volatilityPenalty = volatility * 50;
  const transitionPenalty =
    Math.min(transitions / healthValues.length, 1) * 50;

  // Return score as percentage (0-1)
  return Math.max(0, 100 - volatilityPenalty - transitionPenalty) / 100;
}

// Helper function to format tooltip
function formatTooltip(params: any, stabilityData: any[]): string {
  if (!Array.isArray(params) || params.length === 0) return "";

  const date = params[0].axisValue;
  const dataIndex = params[0].dataIndex;
  const data = stabilityData[dataIndex];

  if (!data) return "";

  let result = `<b>${date}</b><br/>`;
  result += `${params[0].marker} Stability Score: <b>${(data.score * 100).toFixed(1)}%</b><br/>`;
  result += `<span style="color: #999; font-size: 0.85em;">`;
  result += `Volatility: ${(data.volatility * 100).toFixed(1)}% | `;
  result += `Transitions: ${data.transitions}`;
  result += `</span>`;

  return result;
}

// Helper function to get line series
function getLineSeries(data: any[]): any[] {
  return [
    {
      name: "Stability Score",
      type: "line",
      data: data.map((d) => d.score),
      smooth: true,
      symbol: "circle",
      symbolSize: 6,
      lineStyle: { width: 2 },
      itemStyle: {
        color: (params: any) => {
          const score = params.data;
          if (score >= 0.7) return COLOR_SUCCESS;
          if (score >= 0.5) return COLOR_WARNING;
          return COLOR_ERROR;
        },
      },
      areaStyle: {
        opacity: 0.2,
        color: {
          type: "linear",
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: COLOR_SUCCESS },
            { offset: 0.5, color: COLOR_WARNING },
            { offset: 1, color: COLOR_ERROR },
          ],
        },
      },
      markLine: {
        silent: true,
        symbol: "none",
        lineStyle: {
          type: "dashed",
          color: COLOR_WARNING,
          width: 1,
        },
        label: {
          formatter: "Target: 70%",
          position: "end",
        },
        data: [{ yAxis: 0.7 }],
      },
    },
  ];
}

export default function CiStabilityTrendPanel({
  data,
}: {
  data: TrunkHealthData[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  // Group builds by day and determine daily health status
  const buildsByDay = _.groupBy(
    data || [],
    (d) => d.build_started_at?.slice(0, 10) || ""
  );

  const dailyHealth = Object.entries(buildsByDay)
    .map(([day, builds]) => {
      if (!day) return null;
      const sortedBuilds = _.sortBy(builds, "build_started_at");
      const mostRecent = sortedBuilds[sortedBuilds.length - 1];
      return {
        date: day,
        isGreen: mostRecent?.is_green === 1 ? 1 : 0,
      };
    })
    .filter((d) => d !== null)
    .sort((a, b) => a!.date.localeCompare(b!.date)) as {
    date: string;
    isGreen: number;
  }[];

  // Calculate rolling stability score (7-day window)
  const windowSize = 7;
  const stabilityData = dailyHealth
    .map((day, index) => {
      if (index < windowSize - 1) return null; // Not enough data for window

      // Get window of health values
      const windowData = dailyHealth
        .slice(Math.max(0, index - windowSize + 1), index + 1)
        .map((d) => d.isGreen);

      // Calculate volatility
      const mean = _.mean(windowData);
      const squaredDiffs = windowData.map((x) => Math.pow(x - mean, 2));
      const variance = _.mean(squaredDiffs);
      const volatility = Math.sqrt(variance);

      // Count transitions
      const transitions = windowData.reduce((count, current, idx) => {
        if (idx === 0) return 0;
        const previous = windowData[idx - 1];
        return current !== previous ? count + 1 : count;
      }, 0);

      const score = calculateStabilityScore(windowData);

      return {
        date: day.date,
        score,
        volatility,
        transitions,
      };
    })
    .filter((d) => d !== null) as {
    date: string;
    score: number;
    volatility: number;
    transitions: number;
  }[];

  const dates = stabilityData.map((d) => dayjs(d.date).format("MMM D"));

  const options: EChartsOption = {
    title: {
      text: "CI Stability Score Over Time",
      subtext: `7-day rolling window (target: ≥70%)`,
      left: "center",
    },
    grid: GRID_DEFAULT,
    xAxis: {
      type: "category",
      data: dates,
      name: "Date",
      nameLocation: "middle",
      nameGap: 35,
      axisLabel: {
        rotate: 45,
        fontSize: 10,
      },
    },
    yAxis: {
      type: "value",
      name: "Stability Score",
      nameLocation: "middle",
      nameGap: 45,
      min: 0,
      max: 1,
      axisLabel: {
        formatter: (value: number) => `${(value * 100).toFixed(0)}%`,
      },
    },
    series: stabilityData.length > 0 ? getLineSeries(stabilityData) : [],
    tooltip: getCrosshairTooltipConfig(darkMode, (params: any) =>
      formatTooltip(params, stabilityData)
    ),
  };

  return (
    <ChartPaper
      tooltip="Measures consistency of CI health over a 7-day rolling window. Combines two factors: (1) Volatility - how much daily health fluctuates, and (2) State Transitions - how often trunk flips between green and red. Score ranges from 0-100%, with ≥70% being the target. Lower volatility and fewer transitions = higher stability score. This is a leading indicator for CI predictability."
      option={options}
      darkMode={darkMode}
    />
  );
}

