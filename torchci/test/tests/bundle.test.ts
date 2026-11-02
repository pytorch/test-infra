import {
  attemptDuration,
  attemptGroupCount,
  attemptGroupLabel,
  attemptGroups,
  attemptsCaption,
  bundleDuration,
  bundleStatus,
  bundleStatusOf,
  finalOutcome,
  messageFirstLine,
  messageKey,
} from "lib/tests/bundle";

function attempt(
  outcome: Parameters<typeof bundleStatus>[0][number],
  summary: string,
  startedAt: string,
  seconds: number
) {
  return {
    outcome,
    outcome_summary: summary,
    started_at: startedAt,
    ended_at: new Date(Date.parse(startedAt) + seconds * 1000).toISOString(),
  };
}

describe("finalOutcome", () => {
  it("is the last executed attempt's outcome", () => {
    expect(finalOutcome(["failed", "passed"])).toBe("passed");
    expect(finalOutcome(["passed", "failed"])).toBe("failed");
    expect(finalOutcome(["timed_out"])).toBe("timed_out");
  });
  it("is never overridden by a skip", () => {
    expect(finalOutcome(["timed_out", "skipped"])).toBe("timed_out");
    expect(finalOutcome(["failed", "skipped", "skipped"])).toBe("failed");
  });
  it("is skipped when nothing executed", () => {
    expect(finalOutcome(["skipped", "skipped"])).toBe("skipped");
    expect(finalOutcome([])).toBe("skipped");
  });
});

describe("bundleStatus", () => {
  it("names a failure that stood, however it failed", () => {
    expect(bundleStatus(["failed"])).toBe("failed");
    expect(bundleStatus(["error"])).toBe("failed");
    expect(bundleStatus(["crashed", "crashed"])).toBe("failed");
    expect(bundleStatus(["passed", "failed"])).toBe("failed");
  });
  it("keeps a timeout apart, even when its rerun skipped", () => {
    expect(bundleStatus(["timed_out"])).toBe("timed_out");
    expect(bundleStatus(["timed_out", "skipped"])).toBe("timed_out");
  });
  it("calls a pass after a failing attempt flaky", () => {
    expect(bundleStatus(["failed", "passed"])).toBe("flaky");
    expect(bundleStatus(["timed_out", "passed"])).toBe("flaky");
    expect(bundleStatus(["crashed", "skipped", "passed"])).toBe("flaky");
  });
  it("calls passes without a failure passed, however many", () => {
    expect(bundleStatus(["passed"])).toBe("passed");
    expect(bundleStatus(["passed", "passed"])).toBe("passed");
    expect(bundleStatus(["skipped", "passed"])).toBe("passed");
  });
  it("sets expected failures, skips and the rest apart", () => {
    expect(bundleStatus(["xfailed"])).toBe("xfailed");
    expect(bundleStatus(["skipped"])).toBe("skipped");
    expect(bundleStatus(["xpassed"])).toBe("other");
    expect(bundleStatus(["unknown"])).toBe("other");
    expect(bundleStatus(["failed", "xfailed"])).toBe("xfailed");
  });
  it("reads a final outcome with the attempts that led to it", () => {
    expect(bundleStatusOf("passed", ["failed", "passed"])).toBe("flaky");
    expect(bundleStatusOf("passed", ["passed"])).toBe("passed");
    expect(bundleStatusOf("skipped", ["skipped"])).toBe("skipped");
  });
});

describe("attemptsCaption", () => {
  it("counts the attempts of a failure that failed every time", () => {
    expect(attemptsCaption(["failed"])).toBe("1 attempt");
    expect(attemptsCaption(["timed_out"])).toBe("1 attempt");
    expect(attemptsCaption(["failed", "failed", "failed"])).toBe(
      "all 3 attempts"
    );
    expect(attemptsCaption(["crashed", "failed", "error"])).toBe(
      "all 3 attempts"
    );
  });
  it("says when the rerun skipped itself", () => {
    expect(attemptsCaption(["timed_out", "skipped"])).toBe("rerun skipped");
    expect(attemptsCaption(["failed", "skipped", "skipped"])).toBe(
      "rerun skipped"
    );
  });
  it("names the attempt a flaky run passed on", () => {
    expect(attemptsCaption(["failed", "passed"])).toBe("passed on attempt 2");
    expect(attemptsCaption(["timed_out", "skipped", "passed"])).toBe(
      "passed on attempt 3"
    );
  });
  it("places a final failure among passes", () => {
    expect(attemptsCaption(["passed", "failed"])).toBe("attempt 2 of 2");
  });
  it("counts the attempts of a run that was never in trouble", () => {
    expect(attemptsCaption(["passed"])).toBeUndefined();
    expect(attemptsCaption(["passed", "passed"])).toBe("2 attempts");
    expect(attemptsCaption(["skipped", "skipped"])).toBe("2 attempts");
    expect(attemptsCaption(["xfailed"])).toBeUndefined();
  });
});

describe("durations", () => {
  const start = "2026-10-30T14:00:00.000Z";
  it("measures an attempt and never below zero", () => {
    expect(attemptDuration(attempt("passed", "", start, 3.1))).toBe(3100);
    expect(attemptDuration(attempt("passed", "", start, -2))).toBe(0);
  });
  it("sums executed attempts and leaves skips out", () => {
    expect(
      bundleDuration([
        attempt("timed_out", "", start, 1800),
        attempt("skipped", "", start, 5),
        attempt("passed", "", start, 1.2),
      ])
    ).toBe(1801200);
  });
});

describe("messages", () => {
  it("takes the first non-empty line, trimmed", () => {
    expect(messageFirstLine("\n  AssertionError: x != y\n  at foo")).toBe(
      "AssertionError: x != y"
    );
    expect(messageFirstLine("")).toBe("");
  });
  it("ignores temporary paths when comparing", () => {
    expect(
      messageKey("FileNotFoundError: /tmp/tmpab12cd/model.pt is missing")
    ).toBe(messageKey("FileNotFoundError: /tmp/tmpzz98yy/model.pt is missing"));
    expect(messageKey("Error in /var/folders/ab/T/x.py")).toBe(
      messageKey("Error in /var/folders/cd/T/y.py")
    );
    expect(
      messageKey("Error at C:\\Users\\runner\\AppData\\Local\\Temp\\a.py")
    ).toBe(
      messageKey("Error at C:\\Users\\runner\\AppData\\Local\\Temp\\b.py")
    );
    expect(messageKey("Error at /home/user/a.py")).not.toBe(
      messageKey("Error at /home/user/b.py")
    );
  });
});

describe("attemptGroups", () => {
  const start = (minutes: number) =>
    new Date(
      Date.parse("2026-10-30T14:00:00.000Z") + minutes * 60000
    ).toISOString();
  it("folds consecutive attempts that read the same", () => {
    const groups = attemptGroups([
      attempt("failed", "AssertionError: a\nmore", start(0), 0.3),
      attempt("failed", "AssertionError: a\nother detail", start(1), 0.4),
      attempt("failed", "AssertionError: a", start(2), 0.3),
      attempt("passed", "", start(3), 1.2),
    ]);
    expect(groups.map((group) => [group.first, group.last])).toEqual([
      [1, 3],
      [4, 4],
    ]);
    expect(groups[0].outcome).toBe("failed");
    expect(groups[0].message).toBe("AssertionError: a");
    expect(groups[0].duration_milliseconds).toBe(1000);
    expect(attemptGroupLabel(groups[0])).toBe("Attempts 1–3");
    expect(attemptGroupCount(groups[0])).toBe("×3");
    expect(attemptGroupLabel(groups[1])).toBe("Attempt 4");
    expect(attemptGroupCount(groups[1])).toBeUndefined();
  });
  it("starts a new row when the outcome or the message changes", () => {
    const groups = attemptGroups([
      attempt("failed", "A", start(0), 1),
      attempt("failed", "B", start(1), 1),
      attempt("timed_out", "B", start(2), 1),
      attempt("skipped", "", start(3), 0),
    ]);
    expect(groups.map((group) => group.outcome)).toEqual([
      "failed",
      "failed",
      "timed_out",
      "skipped",
    ]);
    expect(groups[3].duration_milliseconds).toBe(0);
  });
  it("folds the same failure in different temp directories", () => {
    const groups = attemptGroups([
      attempt("failed", "missing /tmp/tmpa1/x", start(0), 1),
      attempt("failed", "missing /tmp/tmpb2/x", start(1), 1),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].message).toBe("missing /tmp/tmpa1/x");
  });
});
