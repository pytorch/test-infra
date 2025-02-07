import * as echarts from "echarts";
import { EChartOption } from "echarts";
import { useEffect, useRef } from "react";

const SingleValueGauge = ({ data }: { data: any }) => {
  const chartRef = useRef(null); // Create a ref for the chart container

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }

    let offset = -10;
    const renderData = [
      {
        value: data.value,
        name: data.name,
        title: {
          offsetCenter: ["0%", `${offset}%`],
        },
        detail: {
          valueAnimation: true,
          offsetCenter: ["0%", `${offset + 30}%`],
        },
      },
    ];
    const chartInstance = echarts.init(chartRef.current);
    let option: EChartOption = getOptions(renderData, data.unit);
    chartInstance.setOption(option);
    return () => {
      chartInstance.dispose();
    };
  }, [data]);

  return (
    <div
      ref={chartRef}
      style={{ width: `300px`, minHeight: `200px` }} // Set dimensions
    ></div>
  );
};
export default SingleValueGauge;

function getOptions(data: any[], unit: string) {
  return {
    series: [
      {
        type: "gauge",
        radius: "80%",
        startAngle: 0,
        endAngle: 360,
        splitLine: {
          show: false,
          distance: 0,
          length: 10,
        },
        axisLine: {
          lineStyle: {
            width: 5,
            color: [[1, "#409eff"]],
          },
        },
        axisTick: {
          show: false,
        },
        axisLabel: {
          show: false,
        },
        pointer: {
          show: false,
        },
        title: {
          show: true,
          offsetCenter: [0, "50%"],
          textStyle: {
            fontSize: 18,
          },
        },
        detail: {
          show: true,
          offsetCenter: [0, "-20%"],
          textStyle: {
            fontSize: 20,
          },
          formatter: `{value} ${unit}`,
        },
        data: data,
      },
    ],
  };
}
