import * as echarts from "echarts";
import { EChartOption } from "echarts";
import { Metrics } from "lib/utilization/types";
import { useEffect, useRef } from "react";


const DoubleRingChart = ({ data }: { data: Metrics[] }) => {
  const chartRef = useRef(null); // Create a ref for the chart container

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }

    if (data.length > 2) {
      console.log(
        "Warning: Too many data points for double ring chart, only the first two will be used"
      );
    }

    let offset = -40;
    const renderData = data.map((d, idx) => {
      return {
        value: d.value,
        name: d.displayname,
        title: {
          offsetCenter: ["0%", `${offset + 40 * idx}%`],
        },
        detail: {
          valueAnimation: true,
          offsetCenter: ["0%", `${offset + 20 + 40 * idx}%`],
        },
      };
    });
    console.log(chartRef.current);
    const chartInstance = echarts.init(chartRef.current);
    let option: EChartOption = getOptions(renderData);
    chartInstance.setOption(option);
    return () => {
      chartInstance.dispose();
    };
  }, [data]);

  return (
    <div
      ref={chartRef}
      style={{ width: `350px`, minHeight: `350px` }} // Set dimensions
    ></div>
  );
};
export default DoubleRingChart;

function getOptions(data: any[]) {
  return {
    series: [
      {
        type: "gauge",
        startAngle: 90,
        endAngle: -270,
        pointer: {
          show: false,
        },
        progress: {
          show: true,
          overlap: false,
          roundCap: true,
          clip: false,
          itemStyle: {
            borderWidth: 1,
            borderColor: "#464646",
          },
        },
        axisLine: {
          lineStyle: {
            width: 25,
          },
        },
        splitLine: {
          show: false,
          distance: 0,
          length: 10,
        },
        axisTick: {
          show: false,
        },
        axisLabel: {
          show: false,
          distance: 50,
        },
        title: {
          fontSize: 14,
        },
        data: data,
        detail: {
          width: 80,
          height: 14,
          fontSize: 14,
          color: "inherit",
          borderColor: "inherit",
          borderRadius: 10,
          borderWidth: 1,
          formatter: "{value}%",
        },
      },
    ],
  };
}
