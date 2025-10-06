// Shared utility functions and configurations for vLLM chart components
import {
  COLOR_BG_DARK,
  COLOR_BG_LIGHT,
  COLOR_CROSSHAIR_DARK,
  COLOR_CROSSHAIR_LIGHT,
  COLOR_TEXT_DARK,
  COLOR_TEXT_LIGHT,
} from "./constants";

// Common title configuration with smaller font
export function getChartTitle(text: string, subtext: string) {
  return {
    text,
    subtext,
    textStyle: {
      fontSize: 14,
    },
  };
}

// Common grid configuration
export const GRID_DEFAULT = { top: 80, right: 60, bottom: 60, left: 60 };
export const GRID_COMPACT = { top: 60, right: 8, bottom: 24, left: 64 };
export const GRID_LEFT_WIDE = { top: 70, right: 40, bottom: 60, left: 75 };

// Common crosshair tooltip configuration
export function getCrosshairTooltipConfig(darkMode: boolean, formatter: any) {
  const crosshairColor = darkMode
    ? COLOR_CROSSHAIR_DARK
    : COLOR_CROSSHAIR_LIGHT;

  return {
    trigger: "axis" as const,
    axisPointer: {
      type: "cross" as const,
      crossStyle: {
        color: crosshairColor,
        opacity: 0.5,
      },
      lineStyle: {
        color: crosshairColor,
        opacity: 0.5,
      },
      label: {
        backgroundColor: darkMode ? COLOR_BG_DARK : COLOR_BG_LIGHT,
        color: darkMode ? COLOR_TEXT_DARK : COLOR_TEXT_LIGHT,
      },
    },
    formatter,
  };
}

// Common ReactECharts wrapper props
export function getReactEChartsProps(darkMode: boolean) {
  return {
    theme: darkMode ? "dark-hud" : undefined,
    style: { height: "100%", width: "100%" },
  };
}
