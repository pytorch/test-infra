// Shared color constants for vLLM metrics charts

// Data visualization colors
export const COLOR_SUCCESS = "#3ba272"; // Green - for successful/passing states
export const COLOR_ERROR = "#ee6666"; // Red - for failures/errors
export const COLOR_WARNING = "#fc9403"; // Orange - for warnings/manual actions
export const COLOR_GRAY = "#9e9e9e"; // Gray - for canceled/neutral states
export const COLOR_SUCCESS_LINE = "#00E676"; // Bright green - for success trend lines
export const COLOR_MIXED_LINE = "#FF4081"; // Pink - for mixed success+failed trend lines

// Help icon colors (mode-aware)
export const COLOR_HELP_ICON_DARK = "#00ff00"; // Neon green - for help/info icons in dark mode
export const COLOR_HELP_ICON_LIGHT = "#1976d2"; // Blue - for help/info icons in light mode

// Delta colors (mode-aware)
export const COLOR_DELTA_POSITIVE_DARK = "#00ff00"; // Neon green - for positive deltas in dark mode
export const COLOR_DELTA_POSITIVE_LIGHT = "#2e7d32"; // Dark green - for positive deltas in light mode
export const COLOR_DELTA_NEGATIVE = "#ee6666"; // Red - for negative deltas (same in both modes)
export const COLOR_DELTA_NEUTRAL = "#999"; // Gray - for neutral/zero deltas

// UI element colors (light mode)
export const COLOR_CROSSHAIR_LIGHT = "#000000";
export const COLOR_BG_LIGHT = "#f5f5f5";
export const COLOR_TEXT_LIGHT = "#333";
export const COLOR_BORDER_LIGHT = "#ddd";

// UI element colors (dark mode)
export const COLOR_CROSSHAIR_DARK = "#ffffff";
export const COLOR_BG_DARK = "#555";
export const COLOR_TEXT_DARK = "#fff";

// Border colors
export const COLOR_BORDER_DARK = "#222";
export const COLOR_BORDER_WHITE = "#fff";

// Helper functions for mode-aware colors
export function getHelpIconColor(darkMode: boolean): string {
  return darkMode ? COLOR_HELP_ICON_DARK : COLOR_HELP_ICON_LIGHT;
}

export function getDeltaColor(
  delta: number | null | undefined,
  darkMode: boolean
): string {
  if (delta === null || delta === undefined) return COLOR_DELTA_NEUTRAL;
  if (delta > 0)
    return darkMode ? COLOR_DELTA_POSITIVE_DARK : COLOR_DELTA_POSITIVE_LIGHT;
  if (delta < 0) return COLOR_DELTA_NEGATIVE;
  return COLOR_DELTA_NEUTRAL;
}
