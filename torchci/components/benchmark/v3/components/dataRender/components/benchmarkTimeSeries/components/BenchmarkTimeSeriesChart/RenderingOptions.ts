import dayjs from "dayjs";
import { RawTimeSeriesPoint } from "./type";
const MAX_LEGEND_NAME = 20;
const tooltipFormatter: NonNullable<
  echarts.TooltipComponentOption["formatter"]
> = ((raw: unknown) => {
  const p = Array.isArray(raw) ? raw[0] : (raw as any);
  const meta = p?.data?.meta as RawTimeSeriesPoint | undefined;
  if (!meta) return "";

  const t = dayjs.utc(meta.granularity_bucket).format("YYYY-MM-DD HH:mm [UTC]");
  const pct = meta.value.toFixed(3);
  const commitShort = meta.commit.slice(0, 7);

  return [
    `<div style="font-weight:600;margin-bottom:4px;">${t}</div>`,
    `<div style="font-size:12px;">${p?.data?.legend_name}</div>`,
    `<b>${meta.metric}</b>: <b>${pct}</b><br/>`,
    `commit <code>${commitShort}</code> · workflow ${meta.workflow_id} · branch ${meta.branch}`,
  ].join("");
}) as any;

export const echartRenderingOptions: echarts.EChartsOption = {
  animation: false,
  legend: {
    type: "scroll", // scrollable if many series
    orient: "vertical", // vertical legend
    right: 10,
    top: 20,
    bottom: 20,
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
    left: 60,
    right: 160, // reserve extra space on the right
    top: 40,
    bottom: 20,
    containLabel: true,
  },
  xAxis: {
    type: "time",
    axisLabel: {
      formatter: (v: number) => dayjs.utc(v).format("MM-DD"),
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
  tooltip: {
    trigger: "item",
    triggerOn: "mousemove|click",
    formatter: tooltipFormatter,
  },
};
