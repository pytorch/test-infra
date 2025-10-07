import dayjs from "dayjs";
const MAX_LEGEND_NAME = 20;

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
    left: 10,
    right: 180, // reserve extra space on the right
    top: 40,
    bottom: 5,
    containLabel: true,
  },
  xAxis: {
    type: "time",
    splitNumber: 3,
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

/**
 * use stable scale to pick
  const globalExtents = useMemo(() => {
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;
    for (const d of seriesDatas) {
      for (const p of d) {
        const x = p.value[0] as number;
        const y = p.value[1] as number;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const padY = Math.max((maxY - minY) * 0.05, 1e-6);
    return {
      minX,
      maxX,
      minY: minY - padY,
      maxY: maxY + padY,
    };
  }, [seriesDatas]);

    const option: echarts.EChartsOption = useMemo(() => {
    return {
      ...echartRenderingOptions,
      tooltip: {
        trigger: "item",
        triggerOn: "mousemove|click",
        formatter: tooltipFormatter,
      },
      xAxis: {
        ...(echartRenderingOptions as any).xAxis,
        min: globalExtents.minX === globalExtents.maxX ? 0 : globalExtents.minX,
        max: globalExtents.maxX,
      },
      yAxis: {
        ...(echartRenderingOptions as any).yAxis,
        min: globalExtents.minY === globalExtents.maxY ? 0 : globalExtents.minY,
        max: globalExtents.maxY,
        scale: true,
      },
      series: [...lineSeries, ...overlaySeries],
    };
  }, [lineSeries, overlaySeries]);
*/
