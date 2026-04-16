import * as echarts from "echarts";

// Hardcoded colors from dark mode theme
const backgroundColor = "#1e1e1e";
const textColor = "#e0e0e0";
const borderColor = "#3a3a3a";
const linkColor = "#4a90e2";

// Color palette based on the HUD colors
const colorPalette = [
  "#4a90e2", // Link color / blue
  "#4caf50", // Success color / green
  "#ff9800", // Warning color / orange
  "#f44336", // Failure color / red
  "#0d5a66", // Info button color / cyan
  "#05c091", // Teal
  "#ff8a45", // Orange
  "#8d48e3", // Purple
  "#dd79ff", // Pink
];

const axisCommon = () => {
  return {
    axisLine: {
      lineStyle: {
        color: textColor,
      },
    },
    splitLine: {
      lineStyle: {
        color: borderColor,
      },
    },
    splitArea: {
      areaStyle: {
        color: ["rgba(255,255,255,0.02)", "rgba(255,255,255,0.05)"],
      },
    },
    minorSplitLine: {
      lineStyle: {
        color: borderColor,
      },
    },
  };
};

const theme = {
  darkMode: true,
  color: colorPalette,
  backgroundColor: backgroundColor,
  axisPointer: {
    lineStyle: {
      color: borderColor,
    },
    crossStyle: {
      color: borderColor,
    },
    label: {
      color: textColor,
    },
  },
  legend: {
    textStyle: {
      color: textColor,
    },
  },
  textStyle: {
    color: textColor,
  },
  title: {
    textStyle: {
      color: textColor,
    },
    subtextStyle: {
      color: textColor,
    },
  },
  toolbox: {
    iconStyle: {
      borderColor: textColor,
    },
  },
  dataZoom: {
    borderColor: borderColor,
    textStyle: {
      color: textColor,
    },
    brushStyle: {
      color: "rgba(135,163,206,0.3)",
    },
    handleStyle: {
      color: backgroundColor,
      borderColor: textColor,
    },
    moveHandleStyle: {
      color: textColor,
      opacity: 0.3,
    },
    fillerColor: "rgba(135,163,206,0.2)",
    emphasis: {
      handleStyle: {
        borderColor: linkColor,
        color: backgroundColor,
      },
      moveHandleStyle: {
        color: textColor,
        opacity: 0.7,
      },
    },
    dataBackground: {
      lineStyle: {
        color: borderColor,
        width: 1,
      },
      areaStyle: {
        color: borderColor,
      },
    },
    selectedDataBackground: {
      lineStyle: {
        color: linkColor,
      },
      areaStyle: {
        color: linkColor,
      },
    },
  },
  visualMap: {
    textStyle: {
      color: textColor,
    },
  },
  timeline: {
    lineStyle: {
      color: textColor,
    },
    label: {
      color: textColor,
    },
    controlStyle: {
      color: textColor,
      borderColor: textColor,
    },
  },
  calendar: {
    itemStyle: {
      color: backgroundColor,
    },
    dayLabel: {
      color: textColor,
    },
    monthLabel: {
      color: textColor,
    },
    yearLabel: {
      color: textColor,
    },
  },
  timeAxis: axisCommon(),
  logAxis: axisCommon(),
  valueAxis: axisCommon(),
  categoryAxis: axisCommon(),
  line: {
    symbol: "circle",
  },
  graph: {
    color: colorPalette,
  },
  gauge: {
    title: {
      color: textColor,
    },
  },
  candlestick: {
    itemStyle: {
      color: "#f44336", // Failure color / red
      color0: "#4caf50", // Success color / green
      borderColor: "#f44336", // Failure color / red
      borderColor0: "#4caf50", // Success color / green
    },
  },
};

(theme.categoryAxis as any).splitLine.show = false;
echarts.registerTheme("dark-hud", theme);

// Export the theme name for use in other files
const darkThemeHud = "dark-hud";

export default darkThemeHud;
