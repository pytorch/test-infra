import { confidenceBucket } from "lib/advisor/advisorBadge";
import {
  confidentEnoughToSuppress,
  extractSuppressed,
  isSuppressible,
  SUPPRESSIBLE_VERDICTS,
  suppressibleJobIds,
} from "lib/advisor/advisorSuppression";
import { AdvisorVerdictRow, resolveVerdict } from "lib/advisorVerdictUtils";
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

  // "Least confident wins" is a comparison, and NaN loses every comparison, so
  // an unusable row would be discarded in favour of the usable one -- the
  // opposite of the safe direction. Both orderings are checked because the
  // reducer is order-sensitive in exactly the way that would hide this.
  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["above 1", 1.5],
    ["negative", -0.2],
  ])("a tied row with %s confidence makes the key ambiguous", (_label, bad) => {
    expect(
      resolveVerdict([
        row({ timestamp: AFTER_JOB, confidence: bad }),
        row({ timestamp: AFTER_JOB, confidence: 0.95 }),
      ])
    ).toBeNull();
    expect(
      resolveVerdict([
        row({ timestamp: AFTER_JOB, confidence: 0.95 }),
        row({ timestamp: AFTER_JOB, confidence: bad }),
      ])
    ).toBeNull();
  });

  test("a lone row with an unusable confidence is ambiguous too", () => {
    expect(
      resolveVerdict([row({ timestamp: AFTER_JOB, confidence: Number.NaN })])
    ).toBeNull();
  });

  test("an older row with an unusable confidence does not poison a good newest row", () => {
    expect(
      resolveVerdict([
        row({ timestamp: BEFORE_JOB, confidence: Number.NaN }),
        row({ timestamp: AFTER_JOB, confidence: 0.95 }),
      ])?.confidence
    ).toBe(0.95);
  });
});

describe("isSuppressible", () => {
  test.each(["not_related", "infra_issue", "garbage"])(
    "a confident, fresh %s verdict clears the job",
    (verdict) => {
      expect(isSuppressible(job(), [row({ verdict })])).toBe(true);
    }
  );

  test("no verdict keeps the job blocking", () => {
    expect(isSuppressible(job(), [])).toBe(false);
  });

  test.each(["related", "revert", "unsure"])(
    "%s keeps the job blocking",
    (verdict) => {
      expect(isSuppressible(job(), [row({ verdict })])).toBe(false);
    }
  );

  // The set is the whole policy, so pin it: adding a verdict to
  // AdvisorVerdictType without deciding which side it falls on turns this red.
  test("the suppressible set is exactly the three cleared verdicts", () => {
    expect([...SUPPRESSIBLE_VERDICTS].sort()).toEqual([
      "garbage",
      "infra_issue",
      "not_related",
    ]);
  });

  // Widening the verdict set must not widen the outcome gate with it: an infra
  // fault that stopped the job before it concluded `failure` still blocks.
  test.each(["cancelled", "timed_out", "action_required", "neutral"])(
    "an infra_issue verdict on a %s job still keeps it blocking",
    (conclusion) => {
      expect(
        isSuppressible(job({ conclusion }), [row({ verdict: "infra_issue" })])
      ).toBe(false);
    }
  );

  test.each([0.88, 0.71, 0.5])(
    "confidence %s is below the badge scale's high bucket, so the job keeps blocking",
    (confidence) => {
      // Assert the premise: if the scale is retuned so this is `high` after
      // all, the case below stops testing anything and should fail loudly.
      expect(confidenceBucket(confidence)).not.toBe("high");
      expect(isSuppressible(job(), [row({ confidence })])).toBe(false);
    }
  );

  test("the gate follows the badge scale rather than a copied threshold", () => {
    // The lowest confidence advisorBadge still labels "not related".
    const lowestHigh = 0.89;
    expect(confidenceBucket(lowestHigh)).toBe("high");
    expect(isSuppressible(job(), [row({ confidence: lowestHigh })])).toBe(true);
  });

  // Deriving the gate from the badge scale is deliberate -- the comment must not
  // say "not related" while the gate disagrees -- but it does mean a change to a
  // UI scale moves a merge gate. Pin the number here so that change cannot be
  // silent: retuning `confidenceBucket` turns this red and whoever does it has
  // to decide the merge question on purpose.
  test("the merge gate's effective floor is 0.89 -- retuning the badge scale must be deliberate", () => {
    expect(confidentEnoughToSuppress(0.89)).toBe(true);
    expect(confidentEnoughToSuppress(0.8899)).toBe(false);
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

describe("suppressibleJobIds", () => {
  const OWNER = "pytorch";
  const REPO = "pytorch";
  const OTHER_SHA = "b".repeat(40);

  // Suppression requires BOTH flags, so the default here is both on and the
  // truth table below is what pins that.
  let savedSuppression: string | undefined;
  let savedComment: string | undefined;
  beforeEach(() => {
    savedSuppression = process.env.DRCI_ADVISOR_SUPPRESSION_ENABLED;
    savedComment = process.env.DRCI_ADVISOR_COMMENT_ENABLED;
    process.env.DRCI_ADVISOR_SUPPRESSION_ENABLED = "true";
    process.env.DRCI_ADVISOR_COMMENT_ENABLED = "true";
  });
  afterEach(() => {
    for (const [name, saved] of [
      ["DRCI_ADVISOR_SUPPRESSION_ENABLED", savedSuppression],
      ["DRCI_ADVISOR_COMMENT_ENABLED", savedComment],
    ] as const) {
      if (saved === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved;
      }
    }
  });

  function ids(
    jobs: RecentWorkflowsData[],
    rows: AdvisorVerdictRow[],
    headSha = HEAD_SHA
  ): number[] {
    return [...suppressibleJobIds(OWNER, REPO, headSha, jobs, rows)].sort(
      (a, b) => a - b
    );
  }

  // The whole flag surface, because the interesting cell is the last one: a
  // merge gate must not open while the comment that accounts for it is dark.
  test.each([
    ["true", "true", [1]],
    ["true", "false", []],
    ["false", "true", []],
    ["false", "false", []],
  ])(
    "suppression=%s comment=%s clears %p",
    (suppression, comment, expected) => {
      process.env.DRCI_ADVISOR_SUPPRESSION_ENABLED = suppression;
      process.env.DRCI_ADVISOR_COMMENT_ENABLED = comment;
      expect(ids([job()], [row()])).toEqual(expected);
    }
  );

  test("an unset comment flag is as good as off", () => {
    delete process.env.DRCI_ADVISOR_COMMENT_ENABLED;
    expect(ids([job()], [row()])).toEqual([]);
  });

  test("an advisor-disabled repo clears nothing even with the flag on", () => {
    expect([
      ...suppressibleJobIds(
        OWNER,
        "not-an-advisor-repo",
        HEAD_SHA,
        [job()],
        [row()]
      ),
    ]).toEqual([]);
  });

  test("a verdict for a different head does not clear this head's job", () => {
    expect(ids([job()], [row({ sha: OTHER_SHA })])).toEqual([]);
  });

  test("a FixedString-padded sha still matches the head", () => {
    expect(ids([job()], [row({ sha: `${HEAD_SHA}    ` })])).toEqual([1]);
  });

  test("rows are matched to jobs by the dr_ci_ signal key, not the bare name", () => {
    // Same verdict, keyed by the raw job name instead of `dr_ci_<name>`.
    expect(ids([job()], [row({ signal_key: job().name })])).toEqual([]);
  });

  test("a verdict for one job does not clear a different job", () => {
    const cleared = job({ id: 1 });
    const other = job({
      id: 2,
      name: "pull / linux-jammy-py3.10-gcc11 / build",
    });
    expect(ids([cleared, other], [row()])).toEqual([1]);
  });

  test("no rows at all clears nothing", () => {
    expect(ids([job()], [])).toEqual([]);
  });

  test("an unnamed job is skipped rather than throwing", () => {
    expect(ids([job({ name: undefined })], [row()])).toEqual([]);
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
