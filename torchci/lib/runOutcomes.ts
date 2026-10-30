// A test run's recorded outcomes, as the runs table's outcome column spells
// them, and the ones that are a failure that stood, shared by the API
// (lib/api/tests/test/runs/types.ts validates with them; grid.ts ranks a
// cell's jobs by them) and the test page (lib/tests/grid.ts reads a cell's
// status by them), which imports no values from lib/api. Free of imports,
// so either side can take it without the other's dependencies.
export const RUN_OUTCOMES = [
  "unknown",
  "passed",
  "failed",
  "error",
  "skipped",
  "xfailed",
  "xpassed",
  "crashed",
  "timed_out",
] as const;

export type RunOutcome = (typeof RUN_OUTCOMES)[number];

// The outcomes that are a failure that stood, as the health view and the
// page's statuses count them: not an expected failure, an unexpected pass
// or an unknown, and not a skip.
export const FAILING_OUTCOMES: ReadonlySet<RunOutcome> = new Set<RunOutcome>([
  "failed",
  "error",
  "crashed",
  "timed_out",
]);
