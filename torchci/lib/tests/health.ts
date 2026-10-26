import type { HealthSummary } from "lib/api/tests/types";
import type { Detail } from "lib/tests/environment";
import { facetChoice, FacetOptions, labelOf } from "lib/tests/facets";
import { integerLabel } from "lib/tests/table";

// The status and the counts and rates of a health summary that say how a
// test's runs went. The status is the API's word for it (HealthSummary.status
// documents the rules): failing, a run's last attempt failed; flaky, every
// failing run passed on retry; healthy; skipped, no runs at all, since the
// health table lists a configuration only once something ran or was skipped.
export type HealthCounts = Pick<
  HealthSummary,
  | "status"
  | "runs"
  | "passed_runs"
  | "failed_runs"
  | "flaky_runs"
  | "skipped_runs"
  | "attempts"
  | "pass_rate"
  | "failure_rate"
  | "flaky_rate"
  | "skip_rate"
>;
export type HealthStatus = HealthSummary["status"];

// The statuses set in a block of their hue: the two kinds of trouble, which
// carry the failure rate, and skipped, news of a third kind. Healthy is the
// unremarkable case, plain muted text.
export type BlockStatus = "failing" | "flaky" | "skipped";
export function blockStatus(status: HealthStatus): BlockStatus | null {
  return status === "healthy" ? null : status;
}

// The status as the cell says it, "Failing": the options' label for running
// text with its first letter raised, or the API's spelling when the options
// do not label it.
export function statusLabel(
  status: HealthStatus,
  options: Partial<FacetOptions> | undefined
): string {
  const label = labelOf(status, facetChoice(options ?? {}, "status").values);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// A rate as a percentage with the precision the column has room for: whole
// percents from 10% up, "92%", one decimal below, "3.2%", "0%" for none and
// "<0.1%" for a rate too small to show.
export function rateLabel(rate: number): string {
  const percent = rate * 100;
  if (percent === 0) {
    return "0%";
  }
  if (percent >= 9.95) {
    return `${Math.round(percent)}%`;
  }
  if (percent >= 0.1) {
    return `${percent.toFixed(1)}%`;
  }
  return "<0.1%";
}

// A count with its noun: "1 run", "31 runs".
function countLabel(value: number, noun: string, plural = `${noun}s`): string {
  return `${integerLabel(value)} ${value === 1 ? noun : plural}`;
}

// The rate set beside the status word, for the statuses that have one to
// tell, failing and flaky: the share of runs with a failing attempt, the
// API's failure_rate, which the counts beneath it agree with (derived from
// them if the API gave none); "92%". Null for the other statuses.
export function healthRate(health: HealthCounts): string | null {
  return health.status === "failing" || health.status === "flaky"
    ? rateLabel(health.failure_rate ?? health.failed_runs / health.runs)
    : null;
}

// The cell's second line, in parts set apart by dots: the runs, as "36 of
// 39 runs" when some failed, then what else there is to say, the flaky runs
// when the test is failing (every failing run is flaky when it is flaky) and
// the skipped attempts.
export function healthDetails(health: HealthCounts): string[] {
  const parts = [
    health.status === "failing" || health.status === "flaky"
      ? `${integerLabel(health.failed_runs)} of ${countLabel(
          health.runs,
          "run"
        )}`
      : countLabel(health.runs, "run"),
  ];
  if (health.status === "failing" && health.flaky_runs > 0) {
    parts.push(`${integerLabel(health.flaky_runs)} flaky`);
  }
  if (health.skipped_runs > 0) {
    parts.push(`${integerLabel(health.skipped_runs)} skipped`);
  }
  return parts;
}

// Every count and rate, for the cell's tooltip; a rate the API has none of
// (nothing ran) is a dash, and runs with another outcome than passed or
// failed (xfailed, xpassed, unknown) are counted only when there are any.
export function healthFacts(health: HealthCounts): Detail[] {
  const rate = (value: number | null) =>
    value === null ? "—" : `${(value * 100).toFixed(1)}%`;
  const other = health.runs - health.passed_runs - health.failed_runs;
  return [
    { name: "Runs", value: integerLabel(health.runs) },
    { name: "Passed first time", value: integerLabel(health.passed_runs) },
    { name: "Failed", value: integerLabel(health.failed_runs) },
    { name: "Flaky", value: integerLabel(health.flaky_runs) },
    ...(other > 0
      ? [{ name: "Other outcome", value: integerLabel(other) }]
      : []),
    { name: "Skipped", value: integerLabel(health.skipped_runs) },
    { name: "Attempts", value: integerLabel(health.attempts) },
    { name: "Failure rate", value: rate(health.failure_rate) },
    { name: "Flaky rate", value: rate(health.flaky_rate) },
    { name: "Skip rate", value: rate(health.skip_rate) },
    { name: "Pass rate", value: rate(health.pass_rate) },
  ];
}
