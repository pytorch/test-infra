import {
  buildAssignedReviewers,
  extractPrStatusSection,
  fetchPrStatusState,
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

  test("matches the live ready for review label exactly", () => {
    expect(getPrStatusStage(state({ labels: ["ready for review"] }))).toBe(
      "readyForReview"
    );
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
      "## PR Status: in pre-review\n\n" +
        "All assigned reviewers " +
        "(@blah, @blahb, @pytorch/team) must agree by reacting to the PR " +
        "description that this change is worth pursuing before the PR will be " +
        'marked "in progress".'
    );
  });

  test("in progress", () => {
    expect(
      getPrStatusMessage(state({ labels: [PR_STATUS_LABEL_IN_PROGRESS] }))
    ).toBe(
      "## PR Status: in progress\n\n" +
        "The overall direction of the change is " +
        "good. The next step is to ensure the change passes the automated " +
        "review.\n\n" +
        "To minimize iteration time, feel free to run the pr-review " +
        "skill from the repo locally. The PR will be marked ready for " +
        "maintainer review when automated review passes. To bypass automated " +
        "review, please add the “no automated review” label."
    );
  });

  test("ready for maintainer review", () => {
    expect(
      getPrStatusMessage(state({ labels: [PR_STATUS_LABEL_READY_FOR_REVIEW] }))
    ).toBe(
      "## PR Status: ready for maintainer review\n\n" +
        "Please address comments " +
        "left by our maintainers until the PR is accepted."
    );
  });

  test("approved", () => {
    expect(getPrStatusMessage(state({ isApproved: true }))).toBe(
      "## PR Status: Approved 🚀\n\n" +
        "Please fix all CI failures and trigger " +
        'merge by commenting "@pytorchbot merge".'
    );
  });

  test("pre-review renders an empty list when no reviewer is assigned", () => {
    expect(
      getPrStatusMessage(
        state({ labels: [PR_STATUS_LABEL_TRIAGED], assignedReviewers: [] })
      )
    ).toBe(
      "## PR Status: in pre-review\n\n" +
        "All assigned reviewers () must agree by " +
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
    expect(hasPrStatusLabel(["Ready for Review"])).toBe(false);
    expect(hasPrStatusLabel(["ready-for-review"])).toBe(false);
    expect(hasPrStatusLabel(["in progress "])).toBe(false);
  });
});

describe("renderPrStatusSection", () => {
  test("no stage renders nothing", () => {
    expect(renderPrStatusSection(state())).toBe("");
  });

  test("renders a delimited section", () => {
    const section = renderPrStatusSection(
      state({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
    );
    expect(section).toBe(
      `${PR_STATUS_START}\n## PR Status: in progress\n\nThe overall direction of the change is good. The next step is to ensure the change passes the automated review.\n\nTo minimize iteration time, feel free to run the pr-review skill from the repo locally. The PR will be marked ready for maintainer review when automated review passes. To bypass automated review, please add the “no automated review” label.\n${PR_STATUS_END}\n`
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
    // half-written section must go too, or it is stranded in the comment for
    // good with a complete section stacked above it on every later splice.
    const truncated = `${DRCI_START}${PR_STATUS_START}\n## PR Sta`;
    const section = renderPrStatusSection(
      state({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
    );
    expect(splicePrStatusSection(truncated, section, DRCI_START)).toBe(
      `${DRCI_START}${section}`
    );
  });

  test("stripping an orphan stops at the next section", () => {
    // `results` starts with "## ", which is what formDrciComment always puts
    // after the status -- so this is the real-world boundary.
    const truncated = `${DRCI_START}${PR_STATUS_START}\n## PR Status: in progress\n\nPartial\n${results}`;
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
      extractPrStatusSection(`${DRCI_START}${PR_STATUS_START}\n## PR`)
    ).toBe("");
  });
});

describe("buildAssignedReviewers", () => {
  test("unions requested reviewers with people who already reviewed", () => {
    expect(
      buildAssignedReviewers(
        "pytorch",
        [{ login: "alice" }],
        [],
        [approvingReview("bob")],
        "author"
      )
    ).toEqual(["alice", "bob"]);
  });

  test("dedupes someone who is both requested and has reviewed", () => {
    expect(
      buildAssignedReviewers(
        "pytorch",
        [{ login: "alice" }],
        [],
        [approvingReview("alice")],
        "author"
      )
    ).toEqual(["alice"]);
  });

  test("teams are rendered as org/team and listed after users", () => {
    expect(
      buildAssignedReviewers(
        "pytorch",
        [{ login: "alice" }],
        [{ slug: "core" }],
        [],
        "author"
      )
    ).toEqual(["alice", "pytorch/core"]);
  });

  test("entries with no login or slug are dropped, not rendered as undefined", () => {
    expect(
      buildAssignedReviewers(
        "pytorch",
        [{}, { login: "alice" }],
        [{}],
        [],
        "author"
      )
    ).toEqual(["alice"]);
  });

  test("recovers only review authors with repository access", () => {
    expect(
      buildAssignedReviewers(
        "pytorch",
        [],
        [],
        [
          {
            user: { login: "alice" },
            author_association: "MEMBER",
          },
          {
            user: { login: "alice" },
            author_association: "MEMBER",
          },
          {
            user: { login: "past-contributor" },
            author_association: "CONTRIBUTOR",
          },
          {
            user: { login: "drive-by" },
            author_association: "NONE",
          },
          { user: null, author_association: "MEMBER" },
          {
            user: { login: "author" },
            author_association: "OWNER",
          },
        ] as any,
        "author"
      )
    ).toEqual(["alice"]);
  });
});

function octokitStub({
  reviews = [] as any[],
  pull = {
    user: { login: "author" },
    requested_reviewers: [],
    requested_teams: [],
  } as any,
  reviewsError,
  pullError,
}: {
  reviews?: any[];
  pull?: any;
  reviewsError?: Error;
  pullError?: Error;
} = {}) {
  const listReviews = jest.fn();
  const get = jest.fn(async () => {
    if (pullError) {
      throw pullError;
    }
    return { data: pull };
  });
  const paginate = jest.fn(async () => {
    if (reviewsError) {
      throw reviewsError;
    }
    return reviews;
  });
  return {
    paginate,
    rest: { pulls: { listReviews, get } },
    _get: get,
  } as any;
}

function approvingReview(login: string): any {
  return {
    user: { login },
    state: "APPROVED",
    author_association: "MEMBER",
    submitted_at: "2026-01-01T00:00:00Z",
  };
}

describe("fetchPrStatusState", () => {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("reads approval for a non-triaged PR without fetching reviewers", async () => {
    const octokit = octokitStub({ reviews: [approvingReview("alice")] });
    const state = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "in progress",
    ]);

    expect(state!.isApproved).toBe(true);
    expect(state!.assignedReviewers).toEqual([]);
    expect(octokit._get).not.toHaveBeenCalled();
  });

  test("fetches reviewers for a triaged PR", async () => {
    const octokit = octokitStub({
      reviews: [],
      pull: {
        user: { login: "author" },
        requested_reviewers: [{ login: "alice" }],
        requested_teams: [{ slug: "core" }],
      },
    });
    const state = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "triaged",
    ]);

    expect(state!.assignedReviewers).toEqual(["alice", "pytorch/core"]);
    expect(octokit._get).toHaveBeenCalled();
  });

  test("a reviewer GitHub dropped from requested_reviewers is recovered", async () => {
    const octokit = octokitStub({
      reviews: [
        {
          user: { login: "bob" },
          state: "COMMENTED",
          author_association: "MEMBER",
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
      pull: {
        user: { login: "author" },
        requested_reviewers: [{ login: "alice" }],
        requested_teams: [],
      },
    });
    const state = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "triaged",
    ]);
    expect(state!.assignedReviewers).toEqual(["alice", "bob"]);
  });

  test("the PR author is not listed as a reviewer of their own PR", async () => {
    const octokit = octokitStub({
      reviews: [
        {
          user: { login: "author" },
          state: "COMMENTED",
          author_association: "OWNER",
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
      pull: {
        user: { login: "author" },
        requested_reviewers: [{ login: "alice" }],
        requested_teams: [],
      },
    });
    const state = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "triaged",
    ]);
    expect(state!.assignedReviewers).toEqual(["alice"]);
  });

  test("a drive-by commenter cannot insert themselves into the reviewer list", async () => {
    const octokit = octokitStub({
      reviews: [
        {
          user: { login: "drive-by" },
          state: "COMMENTED",
          author_association: "NONE",
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
      pull: {
        user: { login: "author" },
        requested_reviewers: [{ login: "alice" }],
        requested_teams: [],
      },
    });
    const state = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "triaged",
    ]);
    expect(state!.assignedReviewers).toEqual(["alice"]);
  });

  test("an unauthorized approval does not mark the PR approved", async () => {
    const octokit = octokitStub({
      reviews: [
        {
          user: { login: "drive-by" },
          state: "APPROVED",
          author_association: "NONE",
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const state = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "ready for review",
    ]);
    expect(state!.isApproved).toBe(false);
  });

  test("outstanding changes-requested is not approved", async () => {
    const octokit = octokitStub({
      reviews: [
        approvingReview("alice"),
        {
          user: { login: "bob" },
          state: "CHANGES_REQUESTED",
          author_association: "MEMBER",
          submitted_at: "2026-01-02T00:00:00Z",
        },
      ],
    });
    const state = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "ready for review",
    ]);
    expect(state!.isApproved).toBe(false);
  });

  test("a failed review lookup returns unknown rather than unapproved", async () => {
    const octokit = octokitStub({ reviewsError: new Error("boom") });
    expect(
      await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
        "in progress",
      ])
    ).toBeNull();
  });

  test("a failed reviewer lookup degrades to reviewers seen in reviews when the author is known", async () => {
    const octokit = octokitStub({
      reviews: [approvingReview("alice")],
      pullError: new Error("boom"),
    });
    const state = await fetchPrStatusState(
      octokit,
      "pytorch",
      "pytorch",
      1,
      ["triaged"],
      "author"
    );
    expect(state!.isApproved).toBe(true);
    expect(state!.assignedReviewers).toEqual(["alice"]);
  });

  test("a failed reviewer lookup with no known author drops the list rather than risking the author", async () => {
    const octokit = octokitStub({
      reviews: [approvingReview("author")],
      pullError: new Error("boom"),
    });
    const state = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "triaged",
    ]);
    expect(state!.isApproved).toBe(true);
    expect(state!.assignedReviewers).toEqual([]);
  });

  test("an explicit author wins over the one in the fetched PR", async () => {
    const octokit = octokitStub({
      reviews: [
        {
          user: { login: "real-author" },
          state: "COMMENTED",
          author_association: "MEMBER",
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
      pull: {
        user: { login: "stale" },
        requested_reviewers: [{ login: "alice" }],
        requested_teams: [],
      },
    });
    const state = await fetchPrStatusState(
      octokit,
      "pytorch",
      "pytorch",
      1,
      ["triaged"],
      "real-author"
    );
    expect(state!.assignedReviewers).toEqual(["alice"]);
  });

  test("both reads failing returns unknown, not a false status", async () => {
    const octokit = octokitStub({
      reviewsError: new Error("boom"),
      pullError: new Error("boom"),
    });
    const state = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "triaged",
    ]);
    expect(state).toBeNull();
  });

  test("the greenlight bot exemption is scoped to pytorch/pytorch", async () => {
    const reviews = [
      {
        user: { login: "pytorchgreenlight[bot]" },
        state: "APPROVED",
        author_association: "NONE",
        submitted_at: "2026-01-01T00:00:00Z",
      },
    ];
    expect(
      (await fetchPrStatusState(
        octokitStub({ reviews }),
        "pytorch",
        "pytorch",
        1,
        ["in progress"]
      ))!.isApproved
    ).toBe(true);
    expect(
      (await fetchPrStatusState(
        octokitStub({ reviews }),
        "pytorch",
        "vision",
        1,
        ["in progress"]
      ))!.isApproved
    ).toBe(false);
  });
});
