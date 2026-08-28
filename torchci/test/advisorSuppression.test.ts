import {
  extractSuppressed,
  isSuppressible,
  MIN_SUPPRESSION_CONFIDENCE,
  resolveVerdict,
} from "lib/advisor/advisorSuppression";
import { AdvisorVerdictRow } from "lib/advisorVerdictUtils";
import { RecentWorkflowsData } from "lib/types";

const HEAD_SHA = "a".repeat(40);
const JOB_DONE_AT = "2026-08-28 12:00:00.000";
const AFTER_JOB = "2026-08-28 12:05:00.000";
const BEFORE_JOB = "2026-08-28 11:55:00.000";

function job(
  overrides: Partial<RecentWorkflowsData> = {}
): RecentWorkflowsData {
  return {
    id: 1,
    name: "pull / linux-jammy-py3.10-gcc11 / test",
    conclusion: "failure",
    completed_at: JOB_DONE_AT,
    ...overrides,
  } as unknown as RecentWorkflowsData;
}

function row(overrides: Partial<AdvisorVerdictRow> = {}): AdvisorVerdictRow {
  return {
    sha: HEAD_SHA,
    signal_key: "dr_ci_pull / linux-jammy-py3.10-gcc11 / test",
    verdict: "not_related",
    confidence: 0.95,
    timestamp: AFTER_JOB,
    ...overrides,
  } as unknown as AdvisorVerdictRow;
}

describe("resolveVerdict", () => {
  test("no rows is absent, not a verdict", () => {
    expect(resolveVerdict([])).toBeNull();
  });

  test("newest row wins", () => {
    const resolved = resolveVerdict([
      row({ verdict: "not_related", timestamp: AFTER_JOB }),
      row({ verdict: "related", timestamp: BEFORE_JOB }),
    ]);
    expect(resolved?.verdict).toBe("not_related");
  });

  test("conflicting rows tied at the newest timestamp resolve to null", () => {
    expect(
      resolveVerdict([
        row({ verdict: "not_related", timestamp: AFTER_JOB }),
        row({ verdict: "related", timestamp: AFTER_JOB }),
      ])
    ).toBeNull();
  });

  test("agreeing rows tied at the newest timestamp still resolve", () => {
    expect(
      resolveVerdict([
        row({ timestamp: AFTER_JOB }),
        row({ timestamp: AFTER_JOB }),
      ])?.verdict
    ).toBe("not_related");
  });

  test("tied rows that disagree on confidence resolve to the lowest", () => {
    expect(
      resolveVerdict([
        row({ timestamp: AFTER_JOB, confidence: 0.95 }),
        row({ timestamp: AFTER_JOB, confidence: 0.4 }),
      ])?.confidence
    ).toBe(0.4);
  });

  test("does not trust the caller's ordering", () => {
    const resolved = resolveVerdict([
      row({ verdict: "not_related", timestamp: BEFORE_JOB }),
      row({ verdict: "related", timestamp: AFTER_JOB }),
    ]);
    expect(resolved?.verdict).toBe("related");
  });
});

describe("isSuppressible", () => {
  test("a confident, fresh not_related verdict clears the job", () => {
    expect(isSuppressible(job(), [row()])).toBe(true);
  });

  test("no verdict keeps the job blocking", () => {
    expect(isSuppressible(job(), [])).toBe(false);
  });

  test.each(["related", "revert", "unsure", "garbage", "infra_issue"])(
    "%s keeps the job blocking",
    (verdict) => {
      expect(isSuppressible(job(), [row({ verdict })])).toBe(false);
    }
  );

  test("confidence below the high bucket keeps the job blocking", () => {
    expect(
      isSuppressible(job(), [
        row({ confidence: MIN_SUPPRESSION_CONFIDENCE - 0.01 }),
      ])
    ).toBe(false);
  });

  test("a verdict older than the job's completion is a stale rerun verdict", () => {
    expect(isSuppressible(job(), [row({ timestamp: BEFORE_JOB })])).toBe(false);
  });

  test("a verdict exactly at the job's completion is ambiguous, so it blocks", () => {
    expect(isSuppressible(job(), [row({ timestamp: JOB_DONE_AT })])).toBe(
      false
    );
  });

  test("an unparseable timestamp keeps the job blocking", () => {
    expect(isSuppressible(job(), [row({ timestamp: "not a date" })])).toBe(
      false
    );
    expect(isSuppressible(job({ completed_at: "not a date" }), [row()])).toBe(
      false
    );
  });

  test.each(["cancelled", "timed_out", "action_required", "neutral"])(
    "a %s job never produced a test outcome, so it keeps blocking",
    (conclusion) => {
      expect(isSuppressible(job({ conclusion }), [row()])).toBe(false);
    }
  );

  test("a zero completed_at keeps the job blocking", () => {
    expect(
      isSuppressible(job({ completed_at: "1970-01-01 00:00:00.000000000" }), [
        row(),
      ])
    ).toBe(false);
  });
});

describe("extractSuppressed", () => {
  test("removes cleared jobs in place and returns them in order", () => {
    const blocking = [job({ id: 1 }), job({ id: 2 }), job({ id: 3 })];
    const extracted = extractSuppressed(blocking, new Set([1, 3]));
    expect(extracted.map((j) => j.id)).toEqual([1, 3]);
    expect(blocking.map((j) => j.id)).toEqual([2]);
  });

  test("mutates the caller's array rather than replacing it", () => {
    const blocking = [job({ id: 1 })];
    const sameRef = blocking;
    extractSuppressed(blocking, new Set([1]));
    expect(sameRef).toHaveLength(0);
  });

  test("an empty suppressible set is a no-op", () => {
    const blocking = [job({ id: 1 }), job({ id: 2 })];
    expect(extractSuppressed(blocking, new Set())).toEqual([]);
    expect(blocking).toHaveLength(2);
  });
});
