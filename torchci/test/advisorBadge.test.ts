import {
  ADVISOR_PENDING_ALT,
  ADVISOR_PENDING_ALT_ATTR,
  advisorBadgeUrl,
  ANALYZING_BADGE,
  confidenceBucket,
  drciSignalKeyForJob,
  isStrictlyAfter,
  renderBadgeSvg,
  renderInProgressLine,
  renderVerdictLine,
  selectAdvisorLines,
  verdictBadge,
  verdictCoversRun,
} from "lib/advisor/advisorBadge";

const HUD = "https://hud.pytorch.org";

describe("confidenceBucket", () => {
  it("buckets high/med/low at the 0.89 and 0.70 boundaries", () => {
    expect(confidenceBucket(0.9)).toBe("high");
    expect(confidenceBucket(0.89)).toBe("high");
    expect(confidenceBucket(0.88)).toBe("med");
    expect(confidenceBucket(0.71)).toBe("med");
    expect(confidenceBucket(0.7)).toBe("low");
    expect(confidenceBucket(0.5)).toBe("low");
  });
});

describe("verdictBadge", () => {
  it("encodes confidence in the not-related labels + gradient", () => {
    expect(verdictBadge("not_related", 0.95)).toMatchObject({
      label: "not related",
      color: "#2da44e",
    });
    expect(verdictBadge("not_related", 0.8).label).toBe("probably not related");
    expect(verdictBadge("not_related", 0.5).label).toBe(
      "not related (uncertain)"
    );
  });

  it("encodes confidence in the related labels + gradient", () => {
    expect(verdictBadge("related", 0.95)).toMatchObject({
      label: "related",
      color: "#d1242f",
    });
    expect(verdictBadge("related", 0.8).label).toBe("probably related");
    expect(verdictBadge("related", 0.5).label).toBe("related (uncertain)");
  });

  it("treats legacy 'revert' as the related pole", () => {
    expect(verdictBadge("revert", 0.95).label).toBe("related");
  });

  it("handles garbage / infra_issue / unsure / unknown without confidence wording", () => {
    expect(verdictBadge("garbage", 0.9).label).toBe("garbage");
    expect(verdictBadge("infra_issue", 0.9).label).toBe("infra issue");
    expect(verdictBadge("unsure", 0.9).label).toBe("inconclusive");
    expect(verdictBadge("something_new", 0.9).label).toBe("inconclusive");
  });

  it("gives infra_issue its own color, distinct from garbage", () => {
    expect(verdictBadge("infra_issue", 0.9).color).not.toBe(
      verdictBadge("garbage", 0.9).color
    );
  });

  it("does NOT prefix the badge with 'AI:' (the line carries that)", () => {
    expect(verdictBadge("related", 0.95).label).not.toMatch(/AI/i);
  });
});

describe("renderBadgeSvg", () => {
  it("renders a valid single-segment SVG with the label and color", () => {
    const svg = renderBadgeSvg(verdictBadge("not_related", 0.95));
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("not related");
    expect(svg).toContain("#2da44e");
  });

  it("uses dark text for light (uncertain) fills and escapes the label", () => {
    const svg = renderBadgeSvg(verdictBadge("related", 0.5));
    expect(svg).toContain("#33333a"); // dark text
    expect(svg).toContain("related (uncertain)");
  });

  it("renders the analyzing badge", () => {
    const svg = renderBadgeSvg(ANALYZING_BADGE);
    expect(svg).toContain("analyzing");
    expect(svg).toContain("#9f9f9f");
  });
});

describe("advisorBadgeUrl", () => {
  it("builds an absolute, URL-encoded badge URL", () => {
    const url = advisorBadgeUrl(
      HUD,
      "pytorch",
      "pytorch",
      "abc123",
      "trunk / linux-jammy / test (default, 1, 2)"
    );
    expect(url).toContain("https://hud.pytorch.org/api/drci/advisorBadge?");
    expect(url).toContain("owner=pytorch");
    expect(url).toContain("sha=abc123");
    // job is encoded (spaces/slashes/parens)
    expect(url).toContain("job=trunk+%2F+linux-jammy+%2F+test");
    expect(url).not.toContain("job=trunk / linux");
  });
});

describe("renderInProgressLine / renderVerdictLine", () => {
  it("in-progress: badge only, no expand, pending alt", () => {
    const line = renderInProgressLine(
      HUD,
      "pytorch",
      "pytorch",
      123,
      "abc",
      "trunk / x / test",
      42
    );
    expect(line).toContain("AI verdict:");
    expect(line).toContain("/api/drci/advisorBadge?");
    expect(line).not.toContain("<details>");
    expect(line).toContain("/pr/pytorch/pytorch/123#42");
    // the pending sentinel alt is what the cron matches to keep re-rendering
    expect(line).toContain(`alt="${ADVISOR_PENDING_ALT}"`);
  });

  it("concluded: AI verdict text toggles a details expand with reasoning", () => {
    const line = renderVerdictLine(
      HUD,
      "pytorch",
      "pytorch",
      123,
      "abc",
      "trunk / x / test",
      42,
      "related",
      0.95,
      "Line one.\n  Line two."
    );
    expect(line).toContain("<details><summary>AI verdict:");
    expect(line).toContain("</details>");
    expect(line).toContain("Full reasoning on HUD");
    // multi-line summary collapsed to one line inside the blockquote
    expect(line).toContain("Line one. Line two.");
    expect(line).not.toContain("Line one.\n");
    // alt encodes the concluded outcome and is NOT the pending sentinel
    expect(line).toContain('alt="AI verdict: related"');
    expect(line).not.toContain(ADVISOR_PENDING_ALT);
  });

  it("concluded alt carries the confidence-bucketed label", () => {
    const line = renderVerdictLine(
      HUD,
      "pytorch",
      "pytorch",
      123,
      "abc",
      "trunk / x / test",
      42,
      "not_related",
      0.8,
      "summary"
    );
    expect(line).toContain('alt="AI verdict: probably not related"');
  });

  it("escapes HTML in the summary so it can't break out of the expand", () => {
    const line = renderVerdictLine(
      HUD,
      "pytorch",
      "pytorch",
      123,
      "abc",
      "trunk / x / test",
      42,
      "related",
      0.95,
      "</blockquote></details><img src=x onerror=alert(1)>"
    );
    expect(line).not.toContain("</blockquote></details><img");
    expect(line).toContain("&lt;/blockquote&gt;&lt;/details&gt;");
    // exactly one real closing pair (the structural one we emit)
    expect(line.match(/<\/details>/g)?.length).toBe(1);
  });
});

describe("selectAdvisorLines", () => {
  const jobs = [
    { id: 1, name: "trunk / a / test" },
    { id: 2, name: "trunk / b / test" },
    { id: 3, name: "trunk / c / test" },
    { id: 4, name: "" }, // skipped (no name)
  ];

  it("prefers a finalized verdict, else in-progress, else nothing", () => {
    const verdictByKey = new Map([
      [
        drciSignalKeyForJob("trunk / a / test"),
        { verdict: "related", confidence: 0.95, summary: "done" },
      ],
    ]);
    const inProgress = new Map([
      [
        drciSignalKeyForJob("trunk / b / test"),
        { state: "dispatched", version: "2026-10-16 00:53:36.569" },
      ],
    ]);

    const out = selectAdvisorLines(
      HUD,
      "pytorch",
      "pytorch",
      1,
      "sha",
      jobs,
      verdictByKey,
      inProgress
    );

    expect(out.get(1)).toContain("<details>"); // verdict
    expect(out.get(2)).toContain("AI verdict:"); // in-progress
    expect(out.get(2)).not.toContain("<details>");
    expect(out.has(3)).toBe(false); // no advisor activity
    expect(out.has(4)).toBe(false); // no name
  });

  // pytorch/pytorch#201104: a verdict for the first run of a job, then a rerun
  // at the same commit that finished after it.
  describe("a rerun at the same commit", () => {
    const JOB = "pull / aarch64 / build";
    const KEY = drciSignalKeyForJob(JOB);
    const RERUN_DONE = "2026-10-16 01:13:57";
    const FIRST_DISPATCH = {
      state: "dispatched",
      version: "2026-10-16 00:53:36.569",
    };
    const RERUN_DISPATCH = {
      state: "dispatched",
      version: "2026-10-16 01:20:00.000",
    };
    const verdictAt = (timestamp: string) =>
      new Map([
        [
          KEY,
          { verdict: "not_related", confidence: 0.95, summary: "s", timestamp },
        ],
      ]);
    const select = (
      verdicts: Map<string, any>,
      dispatch: { state: string; version: string } | undefined
    ) =>
      selectAdvisorLines(
        HUD,
        "pytorch",
        "pytorch",
        1,
        "sha",
        [{ id: 7, name: JOB, completedAt: RERUN_DONE }],
        verdicts,
        dispatch ? new Map([[KEY, dispatch]]) : new Map()
      ).get(7);

    it("shows outdated, not the first run's verdict, when nothing is in flight", () => {
      const line = select(verdictAt("2026-10-16 00:54:54.000"), FIRST_DISPATCH);
      expect(line).toContain('alt="AI verdict: outdated"');
      expect(line).not.toContain("not related");
      expect(line).not.toContain(ADVISOR_PENDING_ALT_ATTR);
      expect(line).toContain("since=2026-10-16+01%3A13%3A57");
    });

    it("shows in-progress while the rerun's analysis has not answered", () => {
      const line = select(verdictAt("2026-10-16 00:54:54.000"), RERUN_DISPATCH);
      expect(line).toContain(ADVISOR_PENDING_ALT_ATTR);
      expect(line).not.toContain("<details>");
    });

    // A further rerun finished while the previous analysis was still running:
    // keep the sentinel so the PR stays in the sweep until that answer lands.
    it("keeps the sentinel while an older analysis is unanswered", () => {
      const line = select(verdictAt("2026-10-16 01:00:00.000"), RERUN_DISPATCH);
      expect(line).toContain(ADVISOR_PENDING_ALT_ATTR);
    });

    it("shows the verdict once the rerun's analysis answers", () => {
      const line = select(verdictAt("2026-10-16 01:30:00.000"), RERUN_DISPATCH);
      expect(line).toContain("<details>");
      expect(line).toContain('alt="AI verdict: not related"');
    });

    // An analysis of an earlier run that lands after the rerun finished is not
    // this run's answer.
    it("a late answer to a dispatch made before the run is outdated", () => {
      const line = select(verdictAt("2026-10-16 01:30:00.000"), FIRST_DISPATCH);
      expect(line).toContain('alt="AI verdict: outdated"');
    });

    it("a verdict with no dispatch row is outdated", () => {
      const line = select(verdictAt("2026-10-16 01:30:00.000"), undefined);
      expect(line).toContain('alt="AI verdict: outdated"');
    });

    // The dispatch states could not be read: keep the PR in the sweep.
    it("shows in-progress for every job when dispatch states are unknown", () => {
      const out = selectAdvisorLines(
        HUD,
        "pytorch",
        "pytorch",
        1,
        "sha",
        [
          { id: 7, name: JOB, completedAt: RERUN_DONE },
          { id: 8, name: "pull / other / build", completedAt: RERUN_DONE },
        ],
        verdictAt("2026-10-16 01:30:00.000"),
        null
      );
      expect(out.get(7)).toContain(ADVISOR_PENDING_ALT_ATTR);
      expect(out.get(8)).toContain(ADVISOR_PENDING_ALT_ATTR);
    });

    it("a job with no usable completed_at still shows its verdict", () => {
      const line = selectAdvisorLines(
        HUD,
        "pytorch",
        "pytorch",
        1,
        "sha",
        [{ id: 7, name: JOB, completedAt: "" }],
        verdictAt("2026-10-16 00:54:54.000"),
        new Map()
      ).get(7);
      expect(line).toContain("<details>");
      expect(line).not.toContain("since=");
    });
  });
});

describe("verdictCoversRun", () => {
  const DONE = "2026-10-16 01:13:57";
  const d = (state: string, version: string) => ({ state, version });
  it("needs a live dispatch after the run and a verdict after the dispatch", () => {
    const after = d("dispatched", "2026-10-16 01:20:00.000");
    expect(verdictCoversRun("2026-10-16 01:30:00", DONE, after)).toBe(true);
    expect(
      verdictCoversRun(
        "2026-10-16 01:30:00",
        DONE,
        d("dispatching", after.version)
      )
    ).toBe(true);
    expect(
      verdictCoversRun("2026-10-16 01:30:00", DONE, d("failed", after.version))
    ).toBe(false);
    expect(verdictCoversRun("2026-10-16 01:10:00", DONE, after)).toBe(false);
    expect(
      verdictCoversRun(
        "2026-10-16 01:30:00",
        DONE,
        d("dispatched", "2026-10-16 00:53:36.569")
      )
    ).toBe(false);
    expect(verdictCoversRun("2026-10-16 01:30:00", DONE, undefined)).toBe(
      false
    );
    expect(verdictCoversRun("2026-10-16 01:30:00", "", after)).toBe(false);
  });
});

describe("isStrictlyAfter", () => {
  it("orders parseable times and refuses ties and unknowns", () => {
    expect(isStrictlyAfter("2026-10-16 01:00:01", "2026-10-16 01:00:00")).toBe(
      true
    );
    expect(isStrictlyAfter("2026-10-16 01:00:00", "2026-10-16 01:00:00")).toBe(
      false
    );
    expect(isStrictlyAfter("2026-10-16 01:00:00", "")).toBe(false);
    expect(isStrictlyAfter("", "2026-10-16 01:00:00")).toBe(false);
    expect(isStrictlyAfter("2026-10-16 01:00:00", "garbage")).toBe(false);
    expect(
      isStrictlyAfter("2026-10-16 01:00:00", "1970-01-01 00:00:00.000000000")
    ).toBe(false);
  });
});
