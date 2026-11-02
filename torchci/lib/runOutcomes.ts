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

// The statuses a bundle of attempts can have, worst first: the order the
// commit summary ranks a test's bundles by to count the test once, under its
// worst result. A bundle is one test in one environment, env var set and
// GitHub job with all its retained attempts. Failed is a final failure, error
// or crash; timed_out a final timeout; flaky a final pass after a failing
// attempt; passed a pass with no failing attempt; other an unexpected pass or
// an unknown; xfailed an expected failure; skipped a bundle in which nothing
// executed. The rule itself is bundleStatusOf in lib/tests/bundle.ts for the
// pages and BUNDLE_STATUS_SQL in lib/api/tests/test/runs/query.ts for the
// API, written to agree.
export const BUNDLE_STATUSES = [
  "failed",
  "timed_out",
  "flaky",
  "passed",
  "other",
  "xfailed",
  "skipped",
] as const;

export type BundleStatus = (typeof BUNDLE_STATUSES)[number];
