import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import { useDarkMode } from "lib/DarkModeContext";
import { ChartPaper, getChartTitle, GRID_LEFT_WIDE } from "./chartUtils";
import { COLOR_BORDER_DARK, COLOR_ERROR, COLOR_SUCCESS } from "./constants";

// Helper function to handle heatmap cell click
function handleTrunkHealthClick(params: any) {
  if (params?.componentType === "series") {
    const buildNumber = params?.data?.[3]; // 4th element is build number
    if (buildNumber !== undefined && buildNumber !== null) {
      const url = `https://buildkite.com/vllm/ci/builds/${buildNumber}/`;
      if (typeof window !== "undefined") {
        window.open(url, "_blank");
      }
    }
  }
}

// Helper function to format trunk health tooltip
function formatTrunkHealthTooltip(params: any): string {
  const data = params.data;
  if (!data) return "";

  const date = data[0];
  const hour = data[1];
  const isGreen = data[2] === 1;
  const status = isGreen ? "Green ✓" : "Red ✗";
  const buildNumber = data[3];

  return (
    `<b>${date} ${hour}:00</b><br/>` +
    `Status: <b>${status}</b><br/>` +
    `Build #${buildNumber}`
  );
}

// Helper function to get trunk health series
function getTrunkHealthSeries(processedData: any[]): any {
  return {
    name: "Trunk Status",
    type: "heatmap",
    data: processedData,
    label: {
      show: false,
    },
    emphasis: {
      itemStyle: {
        shadowBlur: 10,
        shadowColor: "rgba(0, 0, 0, 0.5)",
      },
    },
    itemStyle: {
      borderWidth: 1,
      borderColor: COLOR_BORDER_DARK,
    },
  };
}

export default function TrunkHealthPanel({
  data,
}: {
  data: any[] | undefined;
}) {
  const { darkMode } = useDarkMode();

  // Process data into heatmap format: [date, hour, status, buildNumber]
  const processedData = (data || []).map((d: any) => {
    const timestamp = dayjs(d.build_started_at);
    const date = timestamp.format("YYYY-MM-DD");
    const hour = timestamp.hour();
    return [date, hour, d.is_green, d.build_number];
  });

  // Get unique dates and hours for the grid
  const uniqueDates = [...new Set(processedData.map((d) => d[0]))].sort();
  const hours = Array.from({ length: 24 }, (_, i) => i);

  const options: EChartsOption = {
    title: getChartTitle("Main Branch Health", "Build status heatmap"),
    grid: GRID_LEFT_WIDE,
    xAxis: {
      type: "category",
      data: uniqueDates,
      name: "Date",
      nameLocation: "middle",
      nameGap: 40,
      axisLabel: {
        rotate: 45,
        fontSize: 9,
      },
    },
    yAxis: {
      type: "category",
      data: hours,
      name: "Hour",
      nameLocation: "middle",
      nameGap: 50,
      nameRotate: 90,
      axisLabel: {
        formatter: (value: any) => `${value}:00`,
        fontSize: 9,
      },
    },
    visualMap: {
      show: false,
      min: 0,
      max: 1,
      dimension: 2,
      inRange: {
        color: [COLOR_ERROR, COLOR_SUCCESS],
      },
    },
    series: getTrunkHealthSeries(processedData),
    tooltip: {
      position: "top",
      formatter: formatTrunkHealthTooltip,
    },
  };

  return (
    <ChartPaper
      tooltip="Hourly heatmap of main branch CI health. Green cells = CI passed, Red cells = CI failed. Each cell is one CI run; click to view details in Buildkite."
      option={options}
      onEvents={{
        click: handleTrunkHealthClick,
      }}
      darkMode={darkMode}
    />
  );
}
