// The windows the cost page offers: the last whole UTC days, ending at the
// start of today. Plain constants, so the page and the endpoint share them.
export const COST_WINDOWS = ["1d", "3d", "7d"] as const;
export type CostWindow = (typeof COST_WINDOWS)[number];

// A week holds the busy weekdays and the quiet weekend both, so its daily
// average scales to a year without one day's skew.
export const DEFAULT_COST_WINDOW: CostWindow = "7d";

export const COST_WINDOW_DAYS: Record<CostWindow, number> = {
  "1d": 1,
  "3d": 3,
  "7d": 7,
};

export const COST_WINDOW_LABELS: Record<CostWindow, string> = {
  "1d": "1 day",
  "3d": "3 days",
  "7d": "7 days",
};
