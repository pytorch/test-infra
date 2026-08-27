import {
  extractPrStatusSection,
  getPrStatusMessage,
  getPrStatusStage,
  hasPrStatusLabel,
  PR_STATUS_END,
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
  PR_STATUS_LABEL_TRIAGED,
  PR_STATUS_START,
  PrStatusState,
  renderPrStatusSection,
  splicePrStatusSection,
} from "lib/prStatus";

const DRCI_START = "<!-- drci-comment-start -->\n";

function state(overrides: Partial<PrStatusState> = {}): PrStatusState {
  return {
    labels: [],
    isApproved: false,
    assignedReviewers: [],
    ...overrides,
  };
}

describe("getPrStatusStage", () => {
  test("no status label means no stage", () => {
    expect(getPrStatusStage(state({ labels: ["module: cuda"] }))).toBe("none");
  });

  test("triaged with pending reviewers is pre-review", () => {
    expect(
      getPrStatusStage(
        state({
          labels: [PR_STATUS_LABEL_TRIAGED],
          assignedReviewers: ["alice"],
        })
      )
    ).toBe("preReview");
  });

  test("triaged with no reviewer assigned is still pre-review", () => {
    expect(
      getPrStatusStage(
        state({ labels: [PR_STATUS_LABEL_TRIAGED], assignedReviewers: [] })
      )
    ).toBe("preReview");
  });

  test("approval outranks every label", () => {
    expect(
      getPrStatusStage(
        state({
          labels: [PR_STATUS_LABEL_TRIAGED, PR_STATUS_LABEL_IN_PROGRESS],
          isApproved: true,
          assignedReviewers: ["alice"],
        })
      )
    ).toBe("approved");
  });

  test("a PR carrying two labels mid-transition reports the later stage", () => {
    expect(
      getPrStatusStage(
        state({
          labels: [
            PR_STATUS_LABEL_IN_PROGRESS,
            PR_STATUS_LABEL_READY_FOR_REVIEW,
          ],
        })
      )
    ).toBe("readyForReview");
  });
});

describe("getPrStatusMessage", () => {
  test("pre-review names the assigned reviewers", () => {
    expect(
      getPrStatusMessage(
        state({
          labels: [PR_STATUS_LABEL_TRIAGED],
          assignedReviewers: ["blah", "blahb", "pytorch/team"],
        })
      )
    ).toBe(
      "PR Status: in pre-review. All assigned reviewers " +
        "(@blah, @blahb, @pytorch/team) must agree by reacting to the PR " +
        "description that this change is worth pursuing before the PR will be " +
        'marked "in progress".'
    );
  });

  test("in progress", () => {
    expect(
      getPrStatusMessage(state({ labels: [PR_STATUS_LABEL_IN_PROGRESS] }))
    ).toBe("PR Status: in progress.");
  });

  test("ready for maintainer review", () => {
    expect(
      getPrStatusMessage(state({ labels: [PR_STATUS_LABEL_READY_FOR_REVIEW] }))
    ).toBe(
      "PR Status: ready for maintainer review. Please address comments left " +
        "by our maintainers until the PR is accepted."
    );
  });

  test("approved", () => {
    expect(getPrStatusMessage(state({ isApproved: true }))).toBe(
      "PR Status: Approved 🚀. Please fix all CI failures and manually " +
        'request merge by commenting "@pytorchbot merge".'
    );
  });

  test("pre-review renders an empty list when no reviewer is assigned", () => {
    expect(
      getPrStatusMessage(
        state({ labels: [PR_STATUS_LABEL_TRIAGED], assignedReviewers: [] })
      )
    ).toBe(
      "PR Status: in pre-review. All assigned reviewers () must agree by " +
        "reacting to the PR description that this change is worth pursuing " +
        'before the PR will be marked "in progress".'
    );
  });

  test("reviewer names that did not come from GitHub are dropped", () => {
    expect(
      getPrStatusMessage(
        state({
          labels: [PR_STATUS_LABEL_TRIAGED],
          assignedReviewers: ["alice", "](https://evil.example) [x", "bob"],
        })
      )
    ).toContain("(@alice, @bob)");
  });
});

describe("hasPrStatusLabel", () => {
  test("true only for the workflow labels", () => {
    expect(hasPrStatusLabel([])).toBe(false);
    expect(hasPrStatusLabel(["module: cuda"])).toBe(false);
    expect(hasPrStatusLabel(["module: cuda", PR_STATUS_LABEL_TRIAGED])).toBe(
      true
    );
    expect(hasPrStatusLabel([PR_STATUS_LABEL_IN_PROGRESS])).toBe(true);
    expect(hasPrStatusLabel([PR_STATUS_LABEL_READY_FOR_REVIEW])).toBe(true);
  });

  test("matching is exact, so a near-miss label is not a status label", () => {
    expect(hasPrStatusLabel(["Triaged"])).toBe(false);
    expect(hasPrStatusLabel(["ready-for-review"])).toBe(false);
    expect(hasPrStatusLabel(["in progress "])).toBe(false);
  });
});

describe("renderPrStatusSection", () => {
  test("no stage renders nothing", () => {
    expect(renderPrStatusSection(state())).toBe("");
  });

  test("renders a delimited callout", () => {
    const section = renderPrStatusSection(
      state({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
    );
    expect(section).toBe(
      `${PR_STATUS_START}\n> [!NOTE]\n> PR Status: in progress.\n${PR_STATUS_END}\n`
    );
  });
});

describe("splicePrStatusSection", () => {
  const results = "## :link: Helpful Links\nrest of the comment\n";

  test("inserts after the Dr.CI marker when absent", () => {
    const section = renderPrStatusSection(
      state({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
    );
    expect(
      splicePrStatusSection(`${DRCI_START}${results}`, section, DRCI_START)
    ).toBe(`${DRCI_START}${section}${results}`);
  });

  test("replaces an existing section without touching the results", () => {
    const before = renderPrStatusSection(
      state({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
    );
    const after = renderPrStatusSection(
      state({ labels: [PR_STATUS_LABEL_READY_FOR_REVIEW] })
    );
    expect(
      splicePrStatusSection(
        `${DRCI_START}${before}${results}`,
        after,
        DRCI_START
      )
    ).toBe(`${DRCI_START}${after}${results}`);
  });

  test("an empty section removes a stale one", () => {
    const before = renderPrStatusSection(
      state({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
    );
    expect(
      splicePrStatusSection(`${DRCI_START}${before}${results}`, "", DRCI_START)
    ).toBe(`${DRCI_START}${results}`);
  });

  test("splicing is idempotent", () => {
    const section = renderPrStatusSection(
      state({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
    );
    const once = splicePrStatusSection(
      `${DRCI_START}${results}`,
      section,
      DRCI_START
    );
    expect(splicePrStatusSection(once, section, DRCI_START)).toBe(once);
  });

  test("a body without the marker is returned unchanged", () => {
    const section = renderPrStatusSection(
      state({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
    );
    expect(
      splicePrStatusSection("some other comment", section, DRCI_START)
    ).toBe("some other comment");
  });

  test("an orphaned section is dropped entirely, not just its marker", () => {
    // A body GitHub truncated mid-section: start marker, no end marker. The
    // half-written callout must go too, or it is stranded in the comment for
    // good with a complete callout stacked above it on every later splice.
    const truncated = `${DRCI_START}${PR_STATUS_START}\n> [!NOTE]\n> PR Sta`;
    const section = renderPrStatusSection(
      state({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
    );
    expect(splicePrStatusSection(truncated, section, DRCI_START)).toBe(
      `${DRCI_START}${section}`
    );
  });

  test("stripping an orphan stops at the first line that is not a quote", () => {
    // `results` starts with "## ", which is what formDrciComment always puts
    // after the section -- so this is the real-world boundary.
    const truncated = `${DRCI_START}${PR_STATUS_START}\n> [!NOTE]\n> PR Sta\n${results}`;
    expect(splicePrStatusSection(truncated, "", DRCI_START)).toBe(
      `${DRCI_START}${results}`
    );
  });

});

describe("extractPrStatusSection", () => {
  test("round-trips what renderPrStatusSection produced", () => {
    const section = renderPrStatusSection(
      state({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
    );
    expect(extractPrStatusSection(`${DRCI_START}${section}rest`)).toBe(section);
  });

  test("is empty when there is no section", () => {
    expect(extractPrStatusSection(`${DRCI_START}rest`)).toBe("");
  });

  test("is empty for an unterminated section rather than returning garbage", () => {
    expect(
      extractPrStatusSection(`${DRCI_START}${PR_STATUS_START}\n> [!NOTE]\n> PR`)
    ).toBe("");
  });
});
