import { useDarkMode } from 'lib/DarkModeContext';
import ReactECharts from 'echarts-for-react';
import { useRef, useEffect } from 'react';

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
      
      // Update all text elements
      const textElements = dom.querySelectorAll('text');
      const textColor = darkMode ? '#E0E0E0' : '#212529';
      
      textElements.forEach((text: SVGTextElement) => {
        text.style.fill = textColor;
        text.setAttribute('fill', textColor);
      });
    } catch (e) {
      console.error('Failed to update chart colors:', e);
    }
  };

  // Update colors whenever the chart is rendered or dark mode changes
  useEffect(() => {
    const timer = setTimeout(() => {
      updateChartColors();
    }, 100);
    
    // Set up event listener for chart rendering
    if (chartRef.current) {
      const chartElement = chartRef.current as any;
      if (chartElement.getEchartsInstance) {
        const echartsInstance = chartElement.getEchartsInstance();
        echartsInstance.on('rendered', updateChartColors);
        echartsInstance.on('finished', updateChartColors);
      }
    }
    
    return () => clearTimeout(timer);
  }, [darkMode]);
  
  // Merge the base options with dark mode specific options
  const baseOptions = props.option || {};
  const options = {
    ...baseOptions,
    backgroundColor: darkMode ? '#2A2A2A' : undefined,
    textStyle: {
      color: darkMode ? '#E0E0E0' : '#212529',
    },
    legend: {
      ...(baseOptions.legend || {}),
      textStyle: {
        color: darkMode ? '#E0E0E0' : '#212529',
      },
    },
    xAxis: {
      ...(baseOptions.xAxis || {}),
      axisLine: {
        lineStyle: {
          color: darkMode ? '#3A3A3A' : '#D9D9D9',
        },
      },
      axisLabel: {
        color: darkMode ? '#E0E0E0' : '#212529',
      },
    },
    yAxis: {
      ...(baseOptions.yAxis || {}),
      axisLine: {
        lineStyle: {
          color: darkMode ? '#3A3A3A' : '#D9D9D9',
        },
      },
      axisLabel: {
        color: darkMode ? '#E0E0E0' : '#212529',
      },
    },
  };

  return <ReactECharts {...props} option={options} ref={chartRef} />;
}