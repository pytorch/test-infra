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

// The trend's rollups, each period a UTC day, a week from Monday or a
// calendar month, and how many each answer reaches back, the current period
// (through yesterday) included: six weeks of days, half a year of weeks, a
// year and a month of months. A period holds about as many owner and runner
// label cells as a day does, so every rollup's answer stays a few tens of
// thousands of cells (lib/api/tests/cost/query-validation.md).
export const TREND_ROLLUPS = ["day", "week", "month"] as const;
export type TrendRollup = (typeof TREND_ROLLUPS)[number];
export const DEFAULT_TREND_ROLLUP: TrendRollup = "day";

export const TREND_PERIODS: Record<TrendRollup, number> = {
  day: 42,
  week: 26,
  month: 13,
};
