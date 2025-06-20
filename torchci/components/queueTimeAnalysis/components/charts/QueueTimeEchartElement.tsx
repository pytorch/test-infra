import dayjs from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek";
import * as echarts from "echarts";
import { useDarkMode } from "lib/DarkModeContext";
import darkThemeHud from "lib/chartTheme";
import { useEffect, useRef, useState } from "react";

dayjs.extend(isoWeek);

type DataPoint = {
  time: string;
  data: number[];
};

export function QueueTimeEchartElement({
  data,
  granularity,
  chartType = "heatmap",
  chartGroup,
  width,
  height,
  minWidth = "200px",
  minHeight = "300px",
}: {
  chartType: string;
  data?: any[];
  granularity: string;
  chartGroup?: string;
  width?: string;
  height?: string;
  minWidth?: string;
  minHeight?: string;
}) {
  const chartRef = useRef(null); // Create a ref for the chart container
  const chartInstanceRef = useRef<echarts.EChartsType | null>(null);
  const [rawData, setRawData] = useState<any>(null);
  const { darkMode } = useDarkMode();

  const queue_axis_value = generateExponential();

  useEffect(() => {
    if (!data) {
      return;
    }
    if (data.length == 0) {
      return;
    }
    setRawData(data);
  }, [data, granularity]);

  // Initialize chart instance and handle resize events
  useEffect(() => {
    if (!chartRef.current) return;

    // Dispose of any existing chart instance
    if (chartInstanceRef.current) {
      chartInstanceRef.current.dispose();
    }

    // Create new chart with appropriate theme
    const instance = echarts.init(
      chartRef.current,
      darkMode ? darkThemeHud : undefined
    );
    chartInstanceRef.current = instance;

    if (chartGroup) {
      instance.group = chartGroup;
      echarts.connect(chartGroup); // Safe to call multiple times
    }
    // Set up resize handlers
    const handleResize = () => {
      instance.resize();
    };
    window.addEventListener("resize", handleResize);

    const resizeObserver = new ResizeObserver(() => {
      instance.resize();
    });
    resizeObserver.observe(chartRef.current);

    // If we have data already, update the chart
    if (rawData && rawData.length > 0) {
      updateChart(instance, rawData, chartType, granularity, queue_axis_value);
    }

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleResize);
      instance.dispose();
    };
  }, [darkMode]);

  // Update chart options when data or chart type changes
  useEffect(() => {
    if (!rawData || rawData.length === 0 || !chartInstanceRef.current) return;

    updateChart(
      chartInstanceRef.current,
      rawData,
      chartType,
      granularity,
      queue_axis_value
    );
  }, [rawData, chartType, granularity]);

  return (
    <div
      ref={chartRef}
      style={{
        height: height ?? queue_axis_value.length * 5 + "px",
        width: width ?? "100%",
        minHeight: minHeight,
        minWidth: minWidth,
      }}
    />
  );
}

const getTooltipLabelIndicator = (color: string) => {
  return `
      <span style="
        display:inline-block;
        width:10px;
        height:10px;
        border-radius:50%;
        background-color:${color};
        margin-right:6px;
      "></span>`;
};

// Extracted chart update logic to avoid code duplication
function updateChart(
  instance: echarts.EChartsType,
  rawData: any[],
  chartType: string,
  granularity: string,
  queue_axis_value: string[]
) {
  if (rawData.length === 0) return;

  const startTime = getTruncTime(dayjs(rawData[0].time), granularity);
  const endTime = getTruncTime(
    dayjs(rawData[rawData.length - 1].time),
    granularity
  );
  const chartData = generateFilledTimeSeries(
    startTime,
    endTime,
    rawData,
    granularity
  );
  const timeDates = generateTimePoints(startTime, endTime, granularity);

  let chartRenderOptions = {};
  switch (chartType) {
    case "heatmap":
      chartRenderOptions = getHeatMapOptions(
        chartData,
        queue_axis_value,
        timeDates
      );
      break;
    case "histogram_bar_vertical":
      const aggre_hist = sumArrayValues(rawData);
      const { cumulative: cv, total: tv } = getCumulativeList(aggre_hist);
      chartRenderOptions = getHistogramChartVertical(
        aggre_hist,
        queue_axis_value,
        cv,
        tv
      );
      break;
    case "histogram_bar_horizontal":
      const aggre_hist_bar = sumArrayValues(rawData);
      const { cumulative, total } = getCumulativeList(aggre_hist_bar);
      chartRenderOptions = getHistogramChartHorizontal(
        aggre_hist_bar,
        queue_axis_value,
        cumulative,
        total
      );
      break;
    case "max_queue_time_line":
      const maxQueueTimeData = generateFilledTimeSeriesLine(
        startTime,
        endTime,
        rawData,
        granularity,
        "max_queue_time"
      );
      chartRenderOptions = getTimeLineChart(
        maxQueueTimeData,
        timeDates,
        "time",
        "max queue time"
      );
      break;
    case "avg_queued_jobs_count_line":
      const avgCount = generateFilledTimeSeriesLine(
        startTime,
        endTime,
        rawData,
        granularity,
        "avg_queued_job_count"
      );
      chartRenderOptions = getTimeLineChart(
        avgCount,
        timeDates,
        "count",
        "avg # of queued jobs"
      );
      break;

    case "avg_queue_time_line":
      const d = generateFilledTimeSeriesLine(
        startTime,
        endTime,
        rawData,
        granularity,
        "avg_queue_time"
      );
      chartRenderOptions = getTimeLineChart(
        d,
        timeDates,
        "time",
        "avg queued time"
      );
      break;
    case "p50_queue_time_line":
      const p50s = [
        {
          name: "P50",
          type: "line",
          data: generateFilledTimeSeriesLine(
            startTime,
            endTime,
            rawData,
            granularity,
            "p50_index"
          ),
        },
      ];
      chartRenderOptions = getPercentileLineChart(
        p50s,
        timeDates,
        queue_axis_value
      );
      break;
    case "percentile_queue_time_lines":
      const p50 = generateFilledTimeSeriesLine(
        startTime,
        endTime,
        rawData,
        granularity,
        "p50_index"
      );
      const p90 = generateFilledTimeSeriesLine(
        startTime,
        endTime,
        rawData,
        granularity,
        "p90_index"
      );
      const p20 = generateFilledTimeSeriesLine(
        startTime,
        endTime,
        rawData,
        granularity,
        "p20_index"
      );
      const series = [
        {
          name: "P90",
          type: "line",
          data: p90,
        },
        {
          name: "P50",
          type: "line",
          data: p50,
        },
        {
          name: "P20",
          type: "line",
          data: p20,
        },
      ];
      chartRenderOptions = getPercentileLineChart(
        series,
        timeDates,
        queue_axis_value
      );
      break;
    default:
      chartRenderOptions = getHeatMapOptions(
        chartData,
        queue_axis_value,
        timeDates
      );
  }
  instance.setOption(chartRenderOptions, true);
}

const getPercentileLineChart = (
  series: any[],
  xAxisLabels: string[],
  yAxisLabels: string[]
) => {
  return {
    tooltip: {
      trigger: "axis",
      formatter: function (params: any) {
        const lines = [];
        const date = params[0].axisValue;
        lines.push(`<b>${date}</b>`);
        console.log(lines);
        for (const item of params) {
          const idx = item.data;
          const lineName = item.seriesName;
          const dot = getTooltipLabelIndicator(item.color);
          if (idx == 0) {
            lines.push(`${dot}${lineName}: located at range  < 1mins`);
          } else if (idx == yAxisLabels.length - 1) {
            lines.push(`${dot}${lineName}:located at range  > 7days`);
          } else {
            const endRange = yAxisLabels[idx];
            const startRange = yAxisLabels[idx - 1] || "N/A";
            lines.push(
              `${dot}${lineName}: located at range ${startRange} - ${endRange}`
            );
          }
        }
        return lines.join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: xAxisLabels,
    },
    yAxis: {
      type: "category",
      data: yAxisLabels,
    },
    series: series,
  };
};

// convert seconds to human readable format
const formatTime = (value: number) => {
  if (value >= 86400) {
    return (value / 86400).toFixed(1) + "d";
  } else if (value >= 3600) {
    return (value / 3600).toFixed(1) + "h";
  } else if (value >= 60) {
    return (value / 60).toFixed(1) + "m";
  } else {
    return value.toFixed(0) + "s";
  }
};

const getCumulativeList = (data: any[]) => {
  const counts = data.map(Number);
  const total = counts.reduce((a, b) => a + b, 0);
  const cumulative = counts.map((_, i) =>
    counts.slice(0, i + 1).reduce((a, b) => a + b, 0)
  );
  return { cumulative, total };
};

const getTimeLineChart = (
  data: any[],
  xAxisLabels: string[],
  valueFormat: string = "time",
  tooltipLabel: string
) => {
  return {
    tooltip: {
      trigger: "axis",
      formatter: (params: any) => {
        let lines = [];
        const dot = getTooltipLabelIndicator(params[0].color);
        const value = params.length > 0 ? params[0].value : undefined;
        lines.push(`<b>${params[0].axisValue}</b>`);
        let renderValue = value;
        if (valueFormat === "time") {
          renderValue = formatTime(value);
        }
        lines.push(`${dot}${tooltipLabel}: ${renderValue}`);
        return lines.join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: xAxisLabels,
    },
    yAxis: {
      type: "value",
      axisLabel: {
        formatter: (value: number) => {
          let rv = `${value}`;
          if (valueFormat === "time") {
            rv = formatTime(value);
          }
          return rv;
        },
      },
    },
    series: [
      {
        data: data,
        type: "line",
      },
    ],
  };
};

const renderHistogramTooltip = (
  params: any,
  cumulative: number[],
  total: number,
  axis: any
) => {
  const idx = params.dataIndex;
  const xLabel = params.name;
  const value = params.value;
  const percentile = ((cumulative[idx] / total) * 100).toFixed(1);
  const lines = [];
  if (idx == 0) {
    lines.push(`<b>Histogram Bucket: < ${xLabel}</b>`);
  } else if (idx == axis.length - 1) {
    lines.push(`<b>Histogram Bucket: >= ${xLabel}</b>`);
  } else {
    const nextName = axis[idx - 1] || "N/A";
    lines.push(`<b>Histogram Bucket: ${nextName}- ${xLabel}</b>`);
  }

  lines.push(
    `<b>Single Bucket</b>: ${value}% queued jobs landed in the bucket`
  );
  lines.push(
    `<b>Accumulative ≤ ${xLabel}</b>: ${percentile}% of detected queued jobs are ≤ ${xLabel}.`
  );
  return lines.join("<br/>");
};

const getHistogramChartVertical = (
  barData: any[],
  xAxisLabels: string[],
  cumulative: number[],
  total: number
) => {
  return {
    tooltip: {
      position: "top",
      formatter: function (params: any) {
        return renderHistogramTooltip(params, cumulative, total, xAxisLabels);
      },
    },
    grid: {
      top: "50px",
      left: "60px",
    },
    yAxis: {
      type: "category",
      data: xAxisLabels,
    },
    xAxis: {
      type: "value",
    },
    series: [
      {
        data: barData,
        type: "bar",
        barMinHeight: 5,
        symbol: "circle",
      },
    ],
  };
};

const getHistogramChartHorizontal = (
  data: any[],
  xAxisLabels: string[],
  cumulative: any[],
  total: number
) => {
  return {
    tooltip: {
      position: "top",
      formatter: function (params: any) {
        return renderHistogramTooltip(params, cumulative, total, xAxisLabels);
      },
    },
    grid: {
      top: "50px",
      left: "60px",
    },
    xAxis: {
      type: "category",
      data: xAxisLabels,
    },
    yAxis: {
      type: "value",
    },
    series: [
      {
        data: data,
        type: "bar",
        barMinHeight: 1,
      },
    ],
  };
};

const getHeatMapOptions = (
  chartData: any[],
  yaxislabels: string[],
  xAxisLabels: string[]
): any => {
  const maxValue = Math.max(...chartData.map((item) => item[2]));
  const heatmapData = chartData.map((item) => [
    item[0],
    item[1],
    item[2] || "-",
  ]);

  return {
    tooltip: {
      position: "top",
    },
    grid: {
      top: "50px",
      left: "100px",
      right: "50px",
    },
    xAxis: {
      type: "category",
      data: xAxisLabels,
      splitArea: {
        show: true,
      },
    },
    yAxis: {
      type: "category",
      data: yaxislabels,
      splitArea: {
        show: true,
      },
    },
    dataZoom: [
      {
        type: "slider",
        xAxisIndex: 0,
      },
    ],
    visualMap: {
      position: "absolute",
      min: 0,
      max: maxValue > 50 ? maxValue : 50,
      calculable: true,
      orient: "horizontal",
      left: "0%",
      top: "0%",
      type: "piecewise",
      formatter: function (value: any, value2: any) {
        return `${value}-${value2}`;
      },
    },
    series: [
      {
        name: "Queue Time Histogram",
        type: "heatmap",
        data: heatmapData,
        label: {
          show: false,
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowColor: "rgba(0, 0, 0, 0.5)",
          },
        },
      },
    ],
  };
};

function generateExponential() {
  const minutes: string[] = Array.from(
    { length: 60 },
    (_, i) => `${i + 1}mins`
  );
  const hours: string[] = Array.from({ length: 23 }, (_, i) => `${i + 2}hr`);
  const days: string[] = [
    ...Array.from({ length: 6 }, (_, i) => `${i + 2}d`),
    ">7d",
  ];
  const durations: string[] = [...minutes, ...hours, ...days];
  return durations;
}

const generateTimePoints = (
  start: dayjs.Dayjs,
  end: dayjs.Dayjs,
  granularity: string
): string[] => {
  const points: dayjs.Dayjs[] = [];

  let current = start.startOf("minute");
  while (current.isBefore(end) || current.isSame(end)) {
    points.push(current);
    current = getNextDayjs(current, granularity);
  }
  return points.map((point) => point.utc().format("YYYY-MM-DD HH:mm"));
};

const getNextDayjs = (
  current: dayjs.Dayjs,
  granularity: string
): dayjs.Dayjs => {
  const time = current.utc();
  switch (granularity) {
    case "half_hour":
      return time.add(30, "minute");
    case "hour":
      return time.add(1, "hour");
    case "day":
      return time.add(1, "day");
    case "week":
      return time.add(1, "week");
    case "month":
      return time.add(1, "month");
    default:
      return time.add(1, "hour"); // fallback
  }
};

const getTruncTime = (time: dayjs.Dayjs, granularity: string): dayjs.Dayjs => {
  time = time.utc();
  switch (granularity) {
    case "half_hour":
      return time.startOf("hour").add(30, "minute");
    case "hour":
      return time.startOf("hour");
    case "day":
      return time.startOf("day");
    case "week":
      return time.startOf("isoWeek");
    case "month":
      return time.startOf("month");
    default:
      return time.startOf("hour"); // fallback
  }
};

const generateFilledTimeSeries = (
  start: dayjs.Dayjs,
  end: dayjs.Dayjs,
  inputData: DataPoint[],
  granularity: string = ""
): any[] => {
  if (inputData.length == 0) {
    return [];
  }

  // Generate all timestamps
  const timeMap = new Map(
    inputData.map((item) => [dayjs(item.time).utc().format(), item.data])
  );

  const result = [];

  let current = getTruncTime(start, granularity); // normalize

  let rowIdx = 0;
  while (current.isBefore(end) || current.isSame(end)) {
    const key = current.format(); // default format is ISO
    const data = timeMap.get(key) ?? Array(90).fill(0); // fill default

    const d = data.map((value, colIdx) => {
      return [rowIdx, colIdx, value];
    });

    result.push(...d);
    current = getNextDayjs(current, granularity);
    rowIdx++;
  }
  return result;
};

const generateFilledTimeSeriesLine = (
  start: dayjs.Dayjs,
  end: dayjs.Dayjs,
  inputData: any[],
  granularity: string = "",
  field: string
): any[] => {
  if (inputData.length == 0) {
    return [];
  }

  // Generate all timestamps
  const timeMap = new Map(
    inputData.map((item) => [dayjs(item.time).utc().format(), item])
  );
  const result = [];
  let current = getTruncTime(start, granularity); // normalize
  let rowIdx = 0;

  while (current.isBefore(end) || current.isSame(end)) {
    const key = current.format(); // default format is ISO
    const d = timeMap.get(key) ? timeMap.get(key)[field] : 0; // fill default
    result.push(d);
    current = getNextDayjs(current, granularity);
    rowIdx++;
  }

  return result;
};

const sumArrayValues = (data: any[]) => {
  if (data.length === 0) return [];
  const length = data[0].data.length;
  const result = new Array(length).fill(0);
  const total = data
    .map((obj) => obj.data)
    .flat()
    .reduce((sum, val) => sum + val, 0);

  for (const item of data) {
    if (!item.data) {
      continue;
    }
    for (let i = 0; i < length; i++) {
      result[i] += item.data[i] / total;
    }
  }
  return result.map((value) => (value * 100).toFixed(3));
};
