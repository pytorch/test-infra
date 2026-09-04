import { useTheme } from "@mui/material";

/**
 * Single source of truth for the L3 promotion/demotion criteria. The
 * CrcrL3Readiness panel and its summary chip must read from here instead
 * of hardcoding a number, otherwise the two drift.
 *
 * There are six L3 promotion criteria: tenure + five metrics
 * (end-to-end time, max execution time, avg queue time, timeout rate, job
 * pass rate).
 */

export type L3ComparisonDirection = "atLeast" | "below";

export interface L3Threshold {
  key: string;
  label: string;
  /** Human-readable target, e.g. "< 30 min" or "≥ 1 month". */
  targetLabel: string;
  target: number;
  direction: L3ComparisonDirection;
  provisional: boolean;
  demotionRelevant: boolean;
}

// L3 promotion/demotion infrastructure gates.
export const L3_THRESHOLDS = {
  tenureAtL2Days: {
    key: "tenureAtL2Days",
    label: "Time at L2",
    targetLabel: "≥ 1 month",
    target: 30,
    direction: "atLeast",
    provisional: false,
    demotionRelevant: false,
  },
  e2eTimeS: {
    key: "e2eTimeS",
    label: "End-to-End Time (P50)",
    targetLabel: "< 3 h",
    target: 3 * 3600,
    direction: "below",
    provisional: false,
    demotionRelevant: true,
  },
  maxExecTimeS: {
    key: "maxExecTimeS",
    label: "Max Execution Time",
    targetLabel: "< 3 h",
    target: 3 * 3600,
    direction: "below",
    provisional: false,
    demotionRelevant: false,
  },
  avgQueueTimeS: {
    key: "avgQueueTimeS",
    label: "Avg Queue Time",
    targetLabel: "< 30 min",
    target: 30 * 60,
    direction: "below",
    provisional: false,
    demotionRelevant: false,
  },
  timeoutRate: {
    key: "timeoutRate",
    label: "Timeout Rate",
    targetLabel: "< 1%",
    target: 0.01,
    direction: "below",
    provisional: false,
    demotionRelevant: true,
  },
  passRate: {
    key: "passRate",
    label: "Job Pass Rate",
    targetLabel: "≥ 90%",
    target: 0.9,
    direction: "atLeast",
    provisional: false,
    demotionRelevant: true,
  },
} as const satisfies Record<string, L3Threshold>;

/** true = meets the criterion, false = fails it, null = no data to judge. */
export function evaluateL3Threshold(
  threshold: L3Threshold,
  measured: number | null | undefined
): boolean | null {
  if (measured == null || Number.isNaN(measured)) return null;
  return threshold.direction === "below"
    ? measured < threshold.target
    : measured >= threshold.target;
}

// Verdict colors shared by the readiness panel and its summary chip,
// sourced from the theme (not a hardcoded hex pair) so they stay correct
// in both light and dark mode.
export function useL3VerdictColors(): { pass: string; fail: string } {
  const theme = useTheme();
  return { pass: theme.palette.success.main, fail: theme.palette.error.main };
}

// Fixed evaluation windows: promotion metrics must be met throughout the
// most recent 2-week window; demotion conditions are observed over a
// 1-week window.
export const L3_PROMOTION_WINDOW_DAYS = 14;
export const L3_DEMOTION_WINDOW_DAYS = 7;
