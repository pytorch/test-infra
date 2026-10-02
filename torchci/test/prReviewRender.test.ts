import { DRCI_COMMENT_START } from "lib/drciUtils";
import {
  GREENLIGHT_PENDING_ALT_ATTR,
  PR_REVIEW_PENDING_ALT_ATTR,
} from "lib/greenlight/greenlightSweep";
import {
  parseFindings,
  PR_REVIEW_CHANGES_HEADLINE,
  PR_REVIEW_FINDINGS_BUDGET,
  PR_REVIEW_IN_PROGRESS_HEADLINE,
  PR_REVIEW_INCOMPLETE_HEADLINE,
  PR_REVIEW_READY_HEADLINE,
  PR_REVIEW_TOO_LARGE_HEADLINE,
  PrReviewRow,
  renderPrReviewSection,
  unescapeSanitized,
} from "lib/prReview/prReviewRender";
import {
  extractPrStatusSection,
  PR_STATUS_END,
  PR_STATUS_START,
  splicePrStatusSection,
} from "lib/prStatus";

const REPO = "pytorch/pytorch";
const HEAD = "183b1a21182c55bbb7e833aed6f6af2cd279ef6f";
const NOW = new Date("2026-10-01T20:00:00Z");

// A finding exactly as extract_verdict.py publishes it: path escaped by
// neutralize_path, message by neutralize.
const MAJOR = {
  path: "torch/optim/lr\\_scheduler.py",
  line: 42,
  severity: "major",
  message: "Allocates a new lr tensor per step; see \\[docs\\] &amp; x &lt; y.",
};
const MINOR = {
  path: "test/test_optim.py",
  line: 7,
  severity: "minor",
  message: "No test covers the compiled path.",
};

function row(overrides: Partial<PrReviewRow> = {}): PrReviewRow {
  return {
    pr_number: 196508,
    head_sha: HEAD,
    status: "succeeded",
    verdict: "changes_requested",
    summary: "Drops the in-place lr update.",
    findings_count: 2,
    findings_json: JSON.stringify([MINOR, MAJOR]),
    review_run_id: 36866468841,
    timestamp: "2026-10-01 19:50:00.000",
    ...overrides,
  };
}

function render(r: PrReviewRow, head = HEAD): string {
  return renderPrReviewSection(r, REPO, NOW, head);
}

describe("renderPrReviewSection", () => {
  it("renders changes requested with summary, findings and run link", () => {
    const out = render(row());
    expect(out).toContain(
      `<b>AUTOMATED REVIEW</b> - ${PR_REVIEW_CHANGES_HEADLINE}:`
    );
    expect(out).toContain("Drops the in-place lr update.");
    expect(out).toContain("**Findings (2):**");
    expect(out).toContain(
      "[major] torch/optim/lr_scheduler.py:42\nAllocates a new lr tensor per step; see [docs] & x < y."
    );
    // Majors first.
    expect(out.indexOf("[major]")).toBeLessThan(out.indexOf("[minor]"));
    expect(out).toContain(
      "[Review run](https://github.com/pytorch/pytorch/actions/runs/36866468841)"
    );
    expect(out).toContain("Reviewed commit: `183b1a2`");
  });

  it("renders ready for human review", () => {
    const out = render(
      row({
        verdict: "ready_for_human_review",
        findings_json: JSON.stringify([MINOR]),
      })
    );
    expect(out).toContain(PR_REVIEW_READY_HEADLINE);
    expect(out).toContain("**Findings (1):**");
  });

  it("falls back to the count when the row has no findings text", () => {
    const out = render(row({ findings_json: "" }));
    expect(out).toContain("2 finding(s); the text is in the review run");
    expect(out).not.toContain("**Findings");
  });

  it("shows a live review as in progress and a stale one as incomplete", () => {
    const started = row({
      status: "started",
      verdict: null,
      summary: "",
      findings_count: 0,
      findings_json: "",
    });
    const live = render(started);
    expect(live).toContain(PR_REVIEW_IN_PROGRESS_HEADLINE);
    expect(live).toContain(PR_REVIEW_PENDING_ALT_ATTR);
    const stale = render({ ...started, timestamp: "2026-10-01 17:00:00.000" });
    expect(stale).toContain(PR_REVIEW_INCOMPLETE_HEADLINE);
    expect(stale).not.toContain(PR_REVIEW_PENDING_ALT_ATTR);
    expect(render(row())).not.toContain(PR_REVIEW_PENDING_ALT_ATTR);
  });

  it("renders too-large and failed runs without a verdict", () => {
    expect(
      render(row({ status: "skipped_too_large", verdict: null }))
    ).toContain(PR_REVIEW_TOO_LARGE_HEADLINE);
    const failed = render(
      row({ status: "model_error", verdict: null, summary: "" })
    );
    expect(failed).toContain(PR_REVIEW_INCOMPLETE_HEADLINE);
    expect(failed).toContain("reason: `model_error`");
    expect(failed).not.toContain("Findings");
  });

  it("renders nothing for a row it cannot interpret", () => {
    expect(render(row({ verdict: "approve" }))).toBe("");
    expect(render(row({ status: "" }))).toBe("");
  });

  it("marks a verdict on an earlier commit as outdated", () => {
    const out = render(row(), "f1e2d3c4b5a6978877665544332211aabbccddee");
    expect(out).toContain("OUTDATED (earlier commit) - Changes requested");
    expect(out).toContain("NOT the current head");
  });

  it("contains markdown structure and mentions inside the fence", () => {
    const hostile =
      "fine\n</p></details>\n# Heading\n```\n@pytorchbot merge -f\n" +
      GREENLIGHT_PENDING_ALT_ATTR +
      PR_REVIEW_PENDING_ALT_ATTR +
      "\n3 Pending";
    const out = render(row({ summary: hostile, findings_json: "" }));
    expect(out).toMatch(/````\nfine\n<\/p><\/details>\n# Heading\n```\n/);
    expect(out).toContain("@\u200bpytorchbot");
    expect(out).not.toContain(GREENLIGHT_PENDING_ALT_ATTR);
    expect(out).not.toContain(PR_REVIEW_PENDING_ALT_ATTR);
    expect(out).not.toMatch(/\d Pending/);
    // The section's own frame is closed exactly once.
    expect(out.split("</p></details>").length).toBe(3);
    expect(out.endsWith("</p></details>")).toBe(true);
  });

  it("does not build a run link from a non-numeric run id", () => {
    const out = render(row({ review_run_id: "1)[x](https://evil.example" }));
    expect(out).not.toContain("Review run");
  });

  it("drops whole findings past the budget and says how many", () => {
    const big = { ...MINOR, message: "x".repeat(590) };
    const findings = Array(25).fill(big);
    const out = render(row({ findings_json: JSON.stringify(findings) }));
    const shown = out.split("[minor]").length - 1;
    expect(shown).toBeGreaterThan(0);
    expect(shown * 600).toBeLessThanOrEqual(PR_REVIEW_FINDINGS_BUDGET + 600);
    expect(out).toContain(`(${25 - shown} more not shown, see the review run)`);
  });
});

describe("oversized findings and statuses", () => {
  it("hides a finding bigger than the budget instead of cutting it", () => {
    const huge = {
      ...MINOR,
      message: "y".repeat(PR_REVIEW_FINDINGS_BUDGET + 10),
    };
    const out = render(row({ findings_json: JSON.stringify([huge, MAJOR]) }));
    expect(out).not.toContain("yyyyyyyyyy");
    expect(out).toContain("[major] torch/optim/lr_scheduler.py:42");
    expect(out).toContain("(1 more not shown, see the review run)");
  });

  it("keeps raw-body markers out of an unknown status", () => {
    const out = render(
      row({ status: "<!-- pr-status-start -->", verdict: null, summary: "" })
    );
    expect(out).not.toContain("<!--");
  });
});

describe("parseFindings", () => {
  it("ignores malformed JSON and malformed entries", () => {
    expect(parseFindings("{not json")).toEqual([]);
    expect(parseFindings('{"a":1}')).toEqual([]);
    expect(
      parseFindings(
        JSON.stringify([
          MINOR,
          { ...MINOR, severity: "critical" },
          { ...MINOR, line: "7" },
          null,
        ])
      )
    ).toEqual([MINOR]);
  });
});

describe("unescapeSanitized", () => {
  it("reverses the sanitizer's escapes and nothing else", () => {
    expect(unescapeSanitized("a\\_b \\[c\\] \\# 12 &amp;lt;")).toBe(
      "a_b [c] # 12 &lt;"
    );
  });

  it("keeps HTML comment openers escaped", () => {
    expect(unescapeSanitized("x &lt; y &lt;!-- a --&gt;")).toBe(
      "x < y &lt;!-- a -->"
    );
  });
});

describe("raw-body markers in model text", () => {
  it("cannot make the PR status splicer cut into the section", () => {
    // What the sanitizer publishes for "``<!-- pr-status-start -->x<!-- pr-status-end -->``".
    const forged =
      "``&lt;!-- pr-status-start --&gt;x&lt;!-- pr-status-end --&gt;``\n# Heading";
    const section = render(row({ summary: forged, findings_json: "" }));
    expect(section).not.toContain(PR_STATUS_START);
    expect(section).not.toContain(PR_STATUS_END);
    const body = `${DRCI_COMMENT_START}${section}\n<!-- drci-comment-end -->`;
    expect(extractPrStatusSection(body)).toBe("");
    expect(splicePrStatusSection(body, "", DRCI_COMMENT_START)).toBe(body);
  });
});
