import {
  BUNDLE_STATUSES,
  BundleStatus,
  FAILING_OUTCOMES,
  RunOutcome,
} from "lib/runOutcomes";

// The rules a run bundle is read by, shared by the commit page's summary,
// bands and rows, the test page's grid (cellStatus in lib/tests/grid.ts)
// and the unit tests, so each is written once. A bundle is one test in one
// environment, env var set and GitHub job with all its retained attempts,
// in chronological order (started_at, ended_at, id), as the API returns
// them (RunRecord in lib/api/tests/test/runs/types.ts). Free of React.

// The statuses a bundle can have, worst first (lib/runOutcomes.ts), the
// order the summary ranks a test's bundles by to count the test once, under
// its worst result.
export { BUNDLE_STATUSES };
export type { BundleStatus };

// What a bundle's status is called on a row's Outcome cell.
export const BUNDLE_STATUS_WORDS: Record<BundleStatus, string> = {
  failed: "Failed",
  timed_out: "Timed out",
  flaky: "Flaky",
  passed: "Passed",
  other: "Other",
  xfailed: "Expected failure",
  skipped: "Skipped",
};

// The bundles a reader must look at: a failure that stood, a timeout, or a
// pass that took a retry.
export const PROBLEM_STATUSES: readonly BundleStatus[] = [
  "failed",
  "timed_out",
  "flaky",
];

// A bundle's final outcome, the status rule's last word:
// its chronologically last executed attempt's outcome, or skipped when no
// attempt executed. A skip never overrides an executed attempt: a test that
// timed out and was then skipped in its rerun did not recover.
export function finalOutcome(outcomes: readonly RunOutcome[]): RunOutcome {
  for (let index = outcomes.length - 1; index >= 0; index--) {
    if (outcomes[index] !== "skipped") return outcomes[index];
  }
  return "skipped";
}

// The status of a bundle whose final outcome is `final` and whose attempts
// had `outcomes`: failed for a final failure, error or crash; timed out;
// flaky for a final pass after a failing attempt; passed; an expected
// failure; skipped when nothing executed; other for an unexpected pass or
// an unknown.
export function bundleStatusOf(
  final: RunOutcome,
  outcomes: readonly RunOutcome[]
): BundleStatus {
  if (final === "skipped") return "skipped";
  if (final === "timed_out") return "timed_out";
  if (FAILING_OUTCOMES.has(final)) return "failed";
  if (final === "passed") {
    return outcomes.some((outcome) => FAILING_OUTCOMES.has(outcome))
      ? "flaky"
      : "passed";
  }
  return final === "xfailed" ? "xfailed" : "other";
}

export function bundleStatus(outcomes: readonly RunOutcome[]): BundleStatus {
  return bundleStatusOf(finalOutcome(outcomes), outcomes);
}

// The Outcome cell's second line, the attempts in words: a failure or
// timeout that was never retried, "1 attempt"; one that failed every time,
// "all 9 attempts"; one whose rerun skipped itself, "rerun skipped"; a pass
// after a failure, "passed on attempt 2"; a final failure among passes, as a
// test file launched twice gives, "attempt 2 of 2". A bundle that was never
// in trouble says only how many attempts it had when there was more than
// one, "2 attempts", and nothing for one.
export function attemptsCaption(
  outcomes: readonly RunOutcome[]
): string | undefined {
  const status = bundleStatus(outcomes);
  let lastExecuted = -1;
  for (let index = outcomes.length - 1; index >= 0; index--) {
    if (outcomes[index] !== "skipped") {
      lastExecuted = index;
      break;
    }
  }
  if (status === "flaky") return `passed on attempt ${lastExecuted + 1}`;
  if (status === "failed" || status === "timed_out") {
    if (lastExecuted < outcomes.length - 1) return "rerun skipped";
    if (outcomes.length === 1) return "1 attempt";
    const executed = outcomes.filter((outcome) => outcome !== "skipped");
    if (executed.every((outcome) => FAILING_OUTCOMES.has(outcome))) {
      return `all ${executed.length} attempts`;
    }
    return `attempt ${lastExecuted + 1} of ${outcomes.length}`;
  }
  return outcomes.length > 1 ? `${outcomes.length} attempts` : undefined;
}

// What the attempt rows read of an attempt: the API's attempt without its
// report, so the rules can be tested on plain objects.
export interface AttemptLike {
  outcome: RunOutcome;
  outcome_summary: string;
  started_at: string;
  ended_at: string;
}

// How long an attempt ran: its end less its start, never negative.
export function attemptDuration(attempt: AttemptLike): number {
  return Math.max(
    0,
    Date.parse(attempt.ended_at) - Date.parse(attempt.started_at)
  );
}

// A bundle's executed time: every attempt's duration, skips left out, the
// figure the Duration column shows and the `duration` sort orders by.
export function bundleDuration(attempts: readonly AttemptLike[]): number {
  return attempts.reduce(
    (sum, attempt) =>
      attempt.outcome === "skipped" ? sum : sum + attemptDuration(attempt),
    0
  );
}

// The first line of an attempt's message, trimmed; empty when it has none.
export function messageFirstLine(summary: string): string {
  const line = summary.split("\n").find((part) => part.trim() !== "");
  return line === undefined ? "" : line.trim();
}

// Temporary paths, which differ from one attempt to the next while the
// failure is the same: /tmp/..., macOS's /var/folders/..., Windows' Temp
// folders, each up to the next space or quote.
const TEMP_PATH =
  /(\/tmp\/|\/var\/folders\/|[A-Za-z]:\\(?:[^\s'"\\]+\\)*Temp\\)[^\s'"`)\]]*/g;

// The first line of a message with its temporary paths taken out, so two
// attempts that failed the same way in different temp directories compare
// equal.
export function messageKey(summary: string): string {
  return messageFirstLine(summary).replace(TEMP_PATH, "$1…");
}

// Consecutive attempts that read the same, one row each.
export interface AttemptGroup<Attempt extends AttemptLike = AttemptLike> {
  // The attempts, in order; 1-based `first` and `last` are their positions
  // in the bundle.
  attempts: Attempt[];
  first: number;
  last: number;
  outcome: RunOutcome;
  // The first line of the first attempt's message, as written.
  message: string;
  // The group's executed time: its attempts' durations, skips left out.
  duration_milliseconds: number;
}

// A bundle's attempts folded into rows: consecutive attempts with the same
// outcome and the same first message line, temp paths ignored, share one.
export function attemptGroups<Attempt extends AttemptLike>(
  attempts: readonly Attempt[]
): AttemptGroup<Attempt>[] {
  const groups: AttemptGroup<Attempt>[] = [];
  attempts.forEach((attempt, index) => {
    const previous = groups[groups.length - 1];
    const key = messageKey(attempt.outcome_summary);
    if (
      previous !== undefined &&
      previous.outcome === attempt.outcome &&
      messageKey(previous.attempts[0].outcome_summary) === key
    ) {
      previous.attempts.push(attempt);
      previous.last = index + 1;
      previous.duration_milliseconds +=
        attempt.outcome === "skipped" ? 0 : attemptDuration(attempt);
      return;
    }
    groups.push({
      attempts: [attempt],
      first: index + 1,
      last: index + 1,
      outcome: attempt.outcome,
      message: messageFirstLine(attempt.outcome_summary),
      duration_milliseconds:
        attempt.outcome === "skipped" ? 0 : attemptDuration(attempt),
    });
  });
  return groups;
}

// A group's place in the bundle: "Attempt 1", "Attempts 1–9".
export function attemptGroupLabel(group: AttemptGroup): string {
  return group.first === group.last
    ? `Attempt ${group.first}`
    : `Attempts ${group.first}–${group.last}`;
}

// How many attempts a group's pill stands for, after its word: "×9" for
// nine, nothing for one.
export function attemptGroupCount(group: AttemptGroup): string | undefined {
  const count = group.last - group.first + 1;
  return count > 1 ? `×${count}` : undefined;
}
