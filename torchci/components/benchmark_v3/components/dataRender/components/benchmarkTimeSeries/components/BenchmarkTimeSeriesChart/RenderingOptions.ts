import dayjs from "dayjs";
const MAX_LEGEND_NAME = 15;

export const echartRenderingOptions: echarts.EChartsOption = {
  animation: false,
  legend: {
    type: "scroll", // scrollable if many series
    orient: "vertical", // vertical legend
    right: 10,
    top: 20,
    bottom: 20,
    tooltip: { show: true },
    formatter: (name: string) =>
      name.length > MAX_LEGEND_NAME
        ? name.slice(0, MAX_LEGEND_NAME) + "…"
        : name,
    selectedMode: true,
    selector: [
      {
        type: "all",
        title: "All",
      },
      {
        type: "inverse",
        title: "Inv",
      },
    ],
  },
  grid: {
    left: 10,
    right: 180, // reserve extra space on the right
    top: 40,
    bottom: 5,
    containLabel: true,
  },
  xAxis: {
    type: "time",
    axisLabel: {
      formatter: (v: number) => dayjs.utc(v).format("MM-DD HH:mm"),
    },
  },
  yAxis: {
    type: "value",
    min: "dataMin",
    max: "dataMax",
    splitNumber: 5,
    axisLabel: {
      formatter: (v: number) => `${v.toFixed(2)}`,
    },
  },
};
