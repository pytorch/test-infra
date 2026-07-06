import {
  ADVISOR_PENDING_ALT,
  advisorBadgeUrl,
  ANALYZING_BADGE,
  confidenceBucket,
  drciSignalKeyForJob,
  renderBadgeSvg,
  renderInProgressLine,
  renderVerdictLine,
  selectAdvisorLines,
  verdictBadge,
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

  it("handles garbage / unsure / unknown without confidence wording", () => {
    expect(verdictBadge("garbage", 0.9).label).toBe("garbage");
    expect(verdictBadge("unsure", 0.9).label).toBe("inconclusive");
    expect(verdictBadge("something_new", 0.9).label).toBe("inconclusive");
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
    const inProgress = new Set([drciSignalKeyForJob("trunk / b / test")]);

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
});
