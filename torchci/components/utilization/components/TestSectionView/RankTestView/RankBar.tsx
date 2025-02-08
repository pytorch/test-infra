import * as echarts from "echarts";
import { set } from "lodash";
import { useEffect, useRef, useState } from "react";

export function RankBar({
  onRankClick = () => {},
  selectedId,
  data,
  resourceName,
  statType,
}: {
  onRankClick?: (rank: string) => void;
  selectedId?: string|null;
  data: { name: string; resourceName: string; [key: string]: any }[];
  resourceName: string;
  statType: string;
}) {
  const chartRef = useRef(null); // Create a ref for the chart container
  const baseHeight = 10; // Height per item
  const minHeight = 300; // Minimum height for small datasets
  const maxHeight = 600; // Maximum height for very large datasets

  const [chartInstance, setChartInstance] = useState<any>(null);
  const [selectedName, setSelectedName] = useState<any>(null);

  useEffect(() => {
    let instance = chartInstance;
    if (!instance) {
      instance = echarts.init(chartRef.current);
      setChartInstance(chartInstance);
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

    setSelectedName(selectedId);

    const options: echarts.EChartOption = getOptions(echartData, selectedId);
    const handleClick = (params: any) => {
      if (params.componentType === "yAxis") {
        onRankClick(params.value);
        setSelectedName(params.value);
      }
    };

    instance.setOption(options, { notMerge: true });
    instance.on("click", handleClick);
    return () => {
      instance.dispose();
    };
  }, [resourceName, statType, data,selectedId]);

  return (
    <div
      ref={chartRef}
      style={{
        height: Math.min(
          maxHeight,
          Math.max(minHeight, data.length * baseHeight)
        ),
      }}
    />
  );
}

const getOptions = (data: any[],selectedId:any): any => {
  return {
    dataset: {
      source: [["score", "percent", "test"], ...data],
    },
    grid: { containLabel: true },
    xAxis: { name: "percent" },
    yAxis: {
      type: "category",
      triggerEvent: true,
      axisLabel: {
        interval: 0,
        color: function (value: any, index: any) {
          if (value === selectedId) {
            return "red"; // Highlight only clicked item
          }
          return "#333"; // Default color for other items
        },
      },
    },
    visualMap: {
      type: "continuous",
      orient: "horizontal",
      left: "center",
      min: 0,
      max: 100,
      text: ["High Score", "Low Score"],
      // Map the score column to color
      dimension: 0,
      inRange: {
        color: ["#65B581", "#FFCE34", "#FD665F"],
      },
    },
    series: [
      {
        type: "bar",
        encode: {
          x: "percent",
          y: "test",
        },
      },
    ],
  };
};
