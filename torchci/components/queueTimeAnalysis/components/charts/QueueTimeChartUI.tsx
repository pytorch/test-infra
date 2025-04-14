import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";
import dayjs from "dayjs";
import styled from "@emotion/styled";
import { max } from "lodash";

type DataPoint = {
  time: string;
  data: number[];
};


export function QueueTimeChartUI({
  data,
  granularity,
  chartType = "heatmap",
  chartGroup,
  width
}: {
  chartType: string;
  data?: any[];
  granularity: string;
  chartGroup?: string;
  width?:string;

}) {
  const chartRef = useRef(null); // Create a ref for the chart container
  const [chartInstance, setChartInstance] = useState<any>(null);
  const [chartData, setChartData] = useState<any[]>([]);
  const [chartXAxisLabels, setChartXAxisLabels] = useState<string[]>([]);
  const [barData, setBarData] = useState<any[]>([]);
  const [lineData, setLineData] = useState<any[]>([]);
  const [maxQueueTime, setMaxQueueTime] = useState<any[]>([]);


  const exponential_time_labels = generateExponential();

  useEffect(()=>{

    if(!data) {
      return;
    }
    if (data.length == 0) {
      return;
    }

    const startTime = getTruncTime(dayjs(data[0].time), granularity)
    const endTime = getTruncTime(dayjs(data[data.length-1].time), granularity)
    const item = generateFilledTimeSeries(startTime,endTime,data,granularity)
    setChartXAxisLabels(generateTimePoints(startTime,endTime,granularity));
    setChartData(item);


    const lineData = generateFilledTimeSeriesLine(startTime,endTime,data,granularity, 'total_count')
    const maxQueueTimeData = generateFilledTimeSeriesLine(startTime,endTime,data,granularity, 'max_queue_time')
    setMaxQueueTime(maxQueueTimeData)
    setLineData(lineData);

    const barData = sumArrayValues(data)
    setBarData(barData);
  },[data,granularity])

  useEffect(() => {
    let instance = chartInstance;
    if (!instance) {
      instance = echarts.init(chartRef.current);
      if (chartGroup){
        instance.group = chartGroup;
      }
      setChartInstance(chartInstance);
    }

    const options: echarts.EChartOption = getOptions(chartType,chartData,barData,lineData,maxQueueTime,exponential_time_labels, chartXAxisLabels );
    instance.setOption(options, { notMerge: true });
    return () => {
      instance.dispose();
    };
  }, [chartData,chartType]);


  const height = exponential_time_labels.length * 10

  const chartWidth = width? width: "1000px"
  return (
    <div>
      <div>
        <div
        ref={chartRef}
        style={{
          height: `${height}px`,
          width: chartWidth,
        }}
      />
    </div>
  </div>
  );
}

const getOptions = (chartType:string, heatmapData:any[],barData:any[],lineData: any[],maxQueueTime: any[],yaxislabels:string[], xAxisLabels:string[]) => {
  switch (chartType) {
    case 'heatmap':
      return getHeatMapOptions(heatmapData, yaxislabels, xAxisLabels);
    case 'histogram_bar_vertical':
      return getBarOptions(barData, yaxislabels);
    case 'histogram_bar_horizontal':
      return getBarChartHorizontal(barData, yaxislabels);
    case 'count_job_line':
      return getLineChart(lineData, xAxisLabels);
    case 'max_queue_time_line':
      return getLineChart(maxQueueTime, xAxisLabels);
    default:
      return {};
  }
}
const getBarOptions = (barData: any[], xAxisLabels:string[]) => {
  return {
    tooltip: {
      position: 'top'

    },
    grid: {
      top: '50px',
      left: '60px',
    },
    yAxis: {
      type: 'category',
      data: xAxisLabels,
    },
    xAxis: {
      type: 'value'
    },
    series: [
      {
        data: barData,
        type: 'bar',
        barMinHeight: 5,
        symbol: 'circle',
      }
    ]
  };
}

const getLineChart = (data:any[], xAxisLabels:string[])=>{
  return {
    tooltip: {
      position: 'top'
    },
    xAxis: {
      type: 'category',
      data: xAxisLabels,
    },
    yAxis: {
      type: 'value'
    },
    series: [
      {
        data: data,
        type: 'line'
      }
    ]
  };
}

const getBarChartHorizontal = (data:any[], xAxisLabels:string[])=>{
  return {
    tooltip: {
      position: 'top'
    },
    grid: {
      top: '50px',
      left: '60px',
    },
    xAxis: {
      type: 'category',
      data: xAxisLabels,
    },
    yAxis: {
      type: 'value'
    },
    series: [
      {
        data: data,
        type: 'bar',
        barMinHeight: 5,
      }
    ]
  };
}

const getHeatMapOptions = (chartData:any[], yaxislabels:string[], xAxisLabels:string[]): any => {
  const maxValue = Math.max(...chartData.map(item => item[2]));
  const heatmapData = chartData.map(item => [item[0], item[1], item[2] || '-'])

  return  {
    tooltip: {
      position: 'top'
    },
    grid: {
      top: '50px',
      left: '100px',
      right: '50px',
    },
    xAxis: {
      type: 'category',
      data: xAxisLabels,
      splitArea: {
        show: true
      }
    },
    yAxis: {
      type: 'category',
      data: yaxislabels,
      splitArea: {
        show: true
      }
    },
    dataZoom: [
      {
        type: 'slider',
        xAxisIndex: 0,
      },
    ],
    visualMap: {
      position: 'absolute',
      min: 0,
      max: maxValue>50? maxValue: 50,
      calculable: true,
      orient: 'horizontal',
      left: '0%',
      top: '0%',
      type: 'piecewise',
      formatter: function(value:any, value2:any) {
        return `${value}-${value2}`;
      }
    },
    series: [{
      name: 'Queue Time Histogram',
      type: 'heatmap',
      data: heatmapData,
      label: {
        show: false
      },
      emphasis: {
        itemStyle: {
          shadowBlur: 10,
          shadowColor: 'rgba(0, 0, 0, 0.5)'
        }
      }
    }]
  };
};


function generateExponential(){
  const minutes: string[] = Array.from({ length: 60 }, (_, i) => `${i + 1}mins`);
  const hours: string[] = Array.from({ length: 23 }, (_, i) => `${i + 2}hr`);
  const days: string[] = [...Array.from({ length: 6 }, (_, i) => `${i + 2}d`), '>7d'];
  console.log(days)
  const durations: string[] = [...minutes, ...hours, ...days];
  return durations
}

const generateTimePoints = (
  start: dayjs.Dayjs,
  end: dayjs.Dayjs,
  granularity: string,
): string[] => {
  const points: dayjs.Dayjs[] = [];

  let current = start.startOf('minute');
  while (current.isBefore(end) || current.isSame(end)) {
    points.push(current);
    current = getNextDayjs(current, granularity);
  }
  return points.map(point => point.utc().format('YYYY-MM-DD HH:mm'));
};

const getNextDayjs = (current: dayjs.Dayjs, granularity: string): dayjs.Dayjs => {

  const time = current.utc()
  switch (granularity) {
    case 'half_hour':
      return time.add(30, 'minute');
    case 'hour':
      return time.add(1, 'hour');
    case 'day':
      return time.add(1, 'day');
    case 'week':
      return time.add(1, 'week');
    case 'month':
      return time.add(1, 'month');
    default:
      return time.add(1, 'hour'); // fallback
  }
}

const getTruncTime = (time: dayjs.Dayjs, granularity: string): dayjs.Dayjs => {
  time = time.utc()
  switch (granularity) {
    case 'half_hour':
      return time.startOf('hour').add(30, 'minute');
    case 'hour':
      return time.startOf('hour')
    case 'day':
      return time.startOf('day')
    case 'week':
      return time.startOf('week')
    case 'month':
      return time.startOf('month')
    default:
      return time.startOf('hour'); // fallback
  }
}

const generateFilledTimeSeries = (
  start:dayjs.Dayjs,
  end: dayjs.Dayjs,
  inputData: DataPoint[],
  granularity: string = ''
): any[] => {
  if (inputData.length == 0) {
    return [];
  }

  // Generate all timestamps
  const timeMap = new Map(inputData.map(item => [dayjs(item.time).utc().format(), item.data]));
  const result = [];
  let current = getTruncTime(start, granularity)// normalize
  let rowIdx = 0;
  while (current.isBefore(end) || current.isSame(end)) {
    const key = current.format(); // default format is ISO
    const data = timeMap.get(key) ?? Array(90).fill(0); // fill default

    const d = data.map((value, colIdx) => {
      return [rowIdx, colIdx, value]
    })

    result.push(...d);
    current = getNextDayjs(current, granularity);
    rowIdx++;
  }
  return result;
};


const generateFilledTimeSeriesLine = (
  start:dayjs.Dayjs,
  end: dayjs.Dayjs,
  inputData: any[],
  granularity: string = '',
  field: string,
): any[] => {
  if (inputData.length == 0) {
    return [];
  }

  // Generate all timestamps
  const timeMap = new Map(inputData.map(item => [dayjs(item.time).utc().format(), item]));
  const result = [];
  let current = getTruncTime(start, granularity)// normalize
  let rowIdx = 0;

  while (current.isBefore(end) || current.isSame(end)) {
    const key = current.format(); // default format is ISO
    const d = timeMap.get(key)? timeMap.get(key)[field] : 0 // fill default
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

  for (const item of data) {
    for (let i = 0; i < length; i++) {
      result[i] += item.data[i];
    }
  }
  return result;
};
