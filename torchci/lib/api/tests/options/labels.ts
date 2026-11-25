import type {
  HealthStatus,
  HealthWindow,
  RanOn,
  TestLanguage,
} from "lib/api/tests/parameters";

// The labels of the list's fixed choices, which the options serve
// (options.ts) and a view that sets its own window names it by (views.ts).
// How each value reads in running text, after "within the last", "on" and
// "in". Typed by the value sets, so a new value without a label does not
// compile.
export const WINDOW_LABELS: Record<HealthWindow, string> = {
  "3h": "3 hours",
  "12h": "12 hours",
  "1d": "1 day",
  "3d": "3 days",
  "7d": "7 days",
  "14d": "14 days",
};
export const RAN_ON_LABELS: Record<RanOn, string> = {
  main: "main",
  pull_request: "pull requests",
};
export const LANGUAGE_LABELS: Record<TestLanguage, string> = {
  python: "Python",
  cpp: "C++",
  unknown: "Unknown",
};
export const STATUS_LABELS: Record<HealthStatus, string> = {
  failing: "failing",
  flaky: "flaky",
  healthy: "healthy",
  skipped: "skipped",
};
