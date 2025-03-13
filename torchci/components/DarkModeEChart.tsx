import ReactECharts from "echarts-for-react";
import { useDarkMode } from "lib/DarkModeContext";
import { useEffect, useRef } from "react";

export default function DarkModeEChart(props: any) {
  const { darkMode } = useDarkMode();
  const chartRef = useRef(null);

  // Function to update all text colors in the chart SVG
  const updateChartColors = () => {
    if (!chartRef.current) return;

    // Access the DOM elements directly
    const chartElement = chartRef.current as any;
    if (!chartElement || !chartElement.getEchartsInstance) return;

    try {
      const echartsInstance = chartElement.getEchartsInstance();
      const dom = echartsInstance.getDom();
      if (!dom) return;

      const textColor = darkMode ? "#E0E0E0" : "#212529";

      // Update all text elements
      dom.querySelectorAll("text").forEach((text: SVGTextElement) => {
        text.style.fill = textColor;
        text.setAttribute("fill", textColor);
      });

      // Special handling for title text
      dom.querySelectorAll(".ec-title, .ec-title-sub").forEach((el: any) => {
        if (el && el.style) {
          el.style.fill = textColor;
          el.style.color = textColor;
        }

        // Also look for text elements inside titles
        el.querySelectorAll("text, tspan").forEach((text: SVGTextElement) => {
          text.style.fill = textColor;
          text.setAttribute("fill", textColor);
        });
      });

      // Update SVG title and subtitle elements
      dom
        .querySelectorAll(
          '[data-zr-dom-id="zr_0"] title, [data-zr-dom-id="zr_0"] title-sub'
        )
        .forEach((el: any) => {
          if (el && el.style) {
            el.style.fill = textColor;
            el.setAttribute("fill", textColor);
          }
        });
    } catch (e) {
      console.error("Failed to update chart colors:", e);
    }
  };

  // Update colors whenever the chart is rendered or dark mode changes
  useEffect(() => {
    // Set up event listener for chart rendering
    if (chartRef.current) {
      const chartElement = chartRef.current as any;
      if (chartElement.getEchartsInstance) {
        const echartsInstance = chartElement.getEchartsInstance();
        echartsInstance.on("rendered", updateChartColors);
        echartsInstance.on("finished", () => {
          updateChartColors();
          try {
            // Force update title text
            const titleElements = chartElement.ele?.querySelectorAll(
              ".ec-title, .ec-title-sub"
            );
            const textColor = darkMode ? "#E0E0E0" : "#212529";

            titleElements?.forEach((el: any) => {
              if (el && el.style) {
                el.style.fill = textColor;
                el.style.color = textColor;
              }
            });
          } catch (e) {
            console.error("Failed to update title colors:", e);
          }
        });
      }
    }

    // Call updateChartColors immediately too
    updateChartColors();
  }, [darkMode]);

  // Merge the base options with dark mode specific options
  const baseOptions = props.option || {};
  const textColor = darkMode ? "#E0E0E0" : "#212529";

  const options = {
    ...baseOptions,
    backgroundColor: darkMode ? "#2A2A2A" : undefined,
    textStyle: {
      color: textColor,
    },
    // Handle title specifically
    title: {
      ...(baseOptions.title || {}),
      textStyle: {
        ...(baseOptions.title?.textStyle || {}),
        color: textColor,
      },
      subtextStyle: {
        ...(baseOptions.title?.subtextStyle || {}),
        color: textColor,
      },
    },
    legend: {
      ...(baseOptions.legend || {}),
      textStyle: {
        color: textColor,
      },
    },
    // Add tooltip styling
    tooltip: {
      ...(baseOptions.tooltip || {}),
      backgroundColor: darkMode ? "#3A3A3A" : "#E0E0E0",
      borderColor: darkMode ? "#4A4A4A" : "#C0C0C0",
      textStyle: {
        color: darkMode ? "#E0E0E0" : "#212529",
      },
      axisPointer: {
        ...(baseOptions.tooltip?.axisPointer || {}),
        lineStyle: {
          ...(baseOptions.tooltip?.axisPointer?.lineStyle || {}),
          color: darkMode ? "#4A90E2" : "#0064CF",
        },
        crossStyle: {
          ...(baseOptions.tooltip?.axisPointer?.crossStyle || {}),
          color: darkMode ? "#4A90E2" : "#0064CF",
        },
        shadowStyle: {
          ...(baseOptions.tooltip?.axisPointer?.shadowStyle || {}),
          color: darkMode
            ? "rgba(74, 144, 226, 0.1)"
            : "rgba(0, 100, 207, 0.1)",
        },
      },
    },
    xAxis: {
      ...(baseOptions.xAxis || {}),
      axisLine: {
        ...(baseOptions.xAxis?.axisLine || {}),
        lineStyle: {
          ...(baseOptions.xAxis?.axisLine?.lineStyle || {}),
          color: darkMode ? "#3A3A3A" : "#D9D9D9",
        },
      },
      axisLabel: {
        ...(baseOptions.xAxis?.axisLabel || {}),
        color: textColor,
      },
    },
    yAxis: {
      ...(baseOptions.yAxis || {}),
      axisLine: {
        ...(baseOptions.yAxis?.axisLine || {}),
        lineStyle: {
          ...(baseOptions.yAxis?.axisLine?.lineStyle || {}),
          color: darkMode ? "#3A3A3A" : "#D9D9D9",
        },
      },
      axisLabel: {
        ...(baseOptions.yAxis?.axisLabel || {}),
        color: textColor,
      },
      nameTextStyle: {
        ...(baseOptions.yAxis?.nameTextStyle || {}),
        color: textColor,
      },
    },
  };

  return <ReactECharts {...props} option={options} ref={chartRef} />;
}
