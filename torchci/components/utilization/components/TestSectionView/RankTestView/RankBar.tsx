import * as echarts from "echarts";
import { truncate } from "lodash";
import { useEffect, useRef, useState } from "react";

export function RankBar({
  onRankClick = () => {},
  selectedId,
  data,
  resourceName,
  statType,
}: {
  onRankClick?: (rank: string) => void;
  selectedId?: string | null;
  data: { name: string; resourceName: string; [key: string]: any }[];
  resourceName: string;
  statType: string;
}) {
  const chartRef = useRef(null); // Create a ref for the chart container
  const baseHeight = 20; // Height per item
  const minHeight = 300; // Minimum height for small datasets
  const maxHeight = 600; // Maximum height for very large datasets

  const [chartInstance, setChartInstance] = useState<any>(null);
  const [chartData, setChartData] = useState<any[]>([]);

  const handleClick = (params: any) => {
    if (params.componentType === "yAxis") {
      onRankClick(params.value);
    } else if (params.componentType == "series") {
      onRankClick(params.value[2]);
    }
  };

  useEffect(() => {
    if (data.length == 0) {
      return;
    }

    let echartData: any[][] = [];
    let validItems = data
      .filter((item) => {
        return item.resourceName === resourceName;
      })
      .sort((a, b) => {
        return a[statType] - b[statType];
      });

    validItems.map((item) => {
      echartData.push([item[statType], item[statType], item.name]);
    });

    setChartData(echartData);
  }, [data, statType, resourceName]);

  useEffect(() => {
    if (chartData.length == 0) {
      return;
    }

    let instance = chartInstance;
    if (!instance) {
      instance = echarts.init(chartRef.current);
      setChartInstance(chartInstance);
    }

    const options: echarts.EChartOption = getOptions(chartData, selectedId);

    instance.setOption(options, { notMerge: true });
    instance.on("click", handleClick);
    return () => {
      instance.dispose();
    };
  }, [chartData, selectedId]);

  if (chartData.length == 0) {
    return <div></div>;
  }

  return (
    <div
      ref={chartRef}
      style={{
        height: Math.min(
          maxHeight,
          Math.max(minHeight, chartData.length * baseHeight)
        ),
      }}
    />
  );
}

const getOptions = (data: any[], selectedId: any): any => {
  return {
    animation: false,
    dataset: {
      source: [["score", "percent", "test"], ...data],
    },
    grid: { containLabel: true },
    tooltip: {
      trigger: "axis", // Show tooltip when hovering on the axis
      formatter: function (params: any) {
        let yValue = params[0].value; // Get full Y-axis value
        return `${yValue[2]}:<br> ${yValue[0]}%`; // Show full value in tooltip
      },
    },
    xAxis: { name: "percent" },
    yAxis: {
      type: "category",
      triggerEvent: true,
      axisLabel: {
        interval: 0,
        color: function (value: any, index: any) {
          if (value === selectedId) {
            return "blue"; // Highlight only clicked item
          }
          return "#333"; // Default color for other items
        },
        formatter: function (value: any, index: any) {
          if (value.length > 100) {
            return truncate(value, { length: 100 }) + "..."; // Truncate long strings
          }
          return value;
        },
      },
    },
    visualMap: {
      type: "continuous",
      orient: "horizontal",
      left: "center",
      min: 0,
      max: 100,
      text: ["High Usage", "Low Usage"],
      // Map the score column to color
      dimension: 0,
      inRange: {
        color: ["#65B581", "#FFCE34", "#FD665F"],
      },
    },
    series: [
      {
        label: {
          show: true,
          position: "inside",
          color: "black",
          formatter: function (params: any) {
            if (params.value[0] <= 1) {
              return ""; // Hide labels for small values
            }
            return params.value[0] + "%";
          },
        },
        type: "bar",
        encode: {
          x: "percent",
          y: "test",
        },
      },
    ],
  };
};
