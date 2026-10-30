import { PreReviewStatus } from "lib/bot/preReviewUtils";
import {
  buildAssignedReviewers,
  extractPrStatusSection,
  fetchLiveLabels,
  fetchPrStatusState,
  getPrStatusMessage,
  getPrStatusStage,
  hasPrStatusLabel,
  PR_STATUS_END,
  PR_STATUS_LABEL_IN_PROGRESS,
  PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE,
  PR_STATUS_LABEL_READY_FOR_REVIEW,
  PR_STATUS_LABEL_REVIEW_OPT_OUT,
  PR_STATUS_LABEL_TRIAGED,
  PR_STATUS_START,
  PrStatusState,
  renderPrStatusSection,
  splicePrStatusSection,
} from "lib/prStatus";

import nock from "nock";
import { Octokit } from "octokit";

const DRCI_START = "<!-- drci-comment-start -->\n";

function state(overrides: Partial<PrStatusState> = {}): PrStatusState {
  return {
    labels: [],
    isApproved: false,
    assignedReviewers: [],
    ...overrides,
  };
}

function preReview(overrides: Partial<PreReviewStatus> = {}): PreReviewStatus {
  return {
    assigned: ["alice", "bob", "pytorch/core"],
    agreed: ["alice"],
    pending: ["bob", "pytorch/core"],
    rejected: [],
    timedOut: [],
    countedFrom: ["alice"],
    expiresAt: "2026-11-05T16:30:00.000Z",
    deadlinePassed: false,
    isMergeApproved: false,
    lookupFailed: false,
    accepted: false,
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

  test.each([false, undefined])(
    "an approval with merge rights %s cannot hide pre-review",
    (isMergeApproved) => {
      expect(
        getPrStatusStage(
          state({ labels: ["triaged"], isApproved: true, isMergeApproved })
        )
      ).toBe("preReview");
    }
  );

  test("drafts pause pre-review and pre-rollout PRs are excluded", () => {
    expect(
      getPrStatusStage(
        state({ labels: ["triaged"], pullRequest: { draft: true } })
      )
    ).toBe("draft");
    expect(
      getPrStatusStage(
        state({
          labels: ["triaged"],
          pullRequest: { created_at: "2026-08-01T00:00:00Z" },
        })
      )
    ).toBe("none");
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

  test("missing actionable issue outranks the triaged label added with it", () => {
    expect(
      getPrStatusStage(
        state({
          labels: [
            PR_STATUS_LABEL_TRIAGED,
            PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE,
          ],
          assignedReviewers: ["alice"],
        })
      )
    ).toBe("missingActionableIssue");
  });

  test("a later stage outranks a leftover missing actionable issue label", () => {
    expect(
      getPrStatusStage(
        state({
          labels: [
            PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE,
            PR_STATUS_LABEL_IN_PROGRESS,
          ],
        })
      )
    ).toBe("inProgress");
    expect(
      getPrStatusStage(
        state({
          labels: [PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE],
          isApproved: true,
        })
      )
    ).toBe("approved");
  });

  test("an approval no merge rule accepts outranks the other labels", () => {
    expect(
      getPrStatusStage(
        state({
          labels: [PR_STATUS_LABEL_TRIAGED, PR_STATUS_LABEL_IN_PROGRESS],
          isApproved: true,
          isMergeApproved: false,
        })
      )
    ).toBe("needsAdditionalApproval");
  });

  test("an approval no merge rule accepts does not hide a missing actionable issue", () => {
    expect(
      getPrStatusStage(
        state({
          labels: [
            PR_STATUS_LABEL_TRIAGED,
            PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE,
          ],
          isApproved: true,
          isMergeApproved: false,
        })
      )
    ).toBe("missingActionableIssue");
  });

  test.each([
    { labels: ["ready for review"], stage: "readyForReview" },
    { labels: ["in progress"], stage: "inProgress" },
    {
      labels: ["triaged", "missing actionable issue"],
      stage: "missingActionableIssue",
    },
    { labels: ["triaged"], stage: "preReview" },
  ])(
    "failed merge verification preserves the workflow phase: %j",
    ({ labels, stage }) => {
      const current = state({
        labels,
        isApproved: true,
        mergeApprovalLookupFailed: true,
      });
      expect(getPrStatusStage(current)).toBe(stage);
      const message = getPrStatusMessage(current);
      expect(message).toContain("merge eligibility could not be verified");
      expect(message).not.toContain("## PR Status: Approved");
      expect(message).not.toContain("@pytorchbot merge");
    }
  );
});

describe("getPrStatusMessage", () => {
  test("pre-review names only outstanding reviewers without mentions and shows the shared deadline", () => {
    const message = getPrStatusMessage(
      state({ labels: ["triaged"], preReview: preReview() })
    );
    expect(message).toContain(
      "**Waiting for pre-review:** `bob`, `pytorch/core`."
    );
    expect(message).toContain("**Pre-review accepted:** `alice`.");
    expect(message).toContain(
      "**Pre-review deadline:** 2026-11-05 16:30:00 UTC."
    );
    expect(message).toContain("Adding reviewers does not extend this deadline");
    expect(message).not.toMatch(/@(alice|bob|pytorch\/core)/);
    expect(message).toContain(
      "Pre-review is a quick check of the PR's overall direction"
    );
    expect(message).toContain("it does not grant merge approval");
    expect(message).toContain("👍 on the PR description");
    expect(message).toContain("`@pytorchbot pre-review accept` comment");
    expect(message).toContain(
      "request changes with a 👎 on the PR description"
    );
  });

  test("silent reviewers disappear after expiry without being credited as accepting", () => {
    const message = getPrStatusMessage(
      state({
        labels: ["triaged"],
        preReview: preReview({
          pending: ["bob"],
          rejected: ["bob"],
          timedOut: ["pytorch/core"],
          deadlinePassed: true,
        }),
      })
    );
    expect(message).toContain("**Pre-review request changes:** `bob`.");
    expect(message).toContain("These block pre-review and do not expire");
    expect(message).not.toContain("`pytorch/core`");
    expect(message).not.toContain("accepted after timeout");
    expect(message).toContain("**Pre-review accepted:** `alice`.");
    expect(message).toContain("This deadline has passed");
    expect(message).not.toContain("Waiting for pre-review:");
  });

  test("missing history and failed lookups never display successful acceptance", () => {
    const unknown = getPrStatusMessage(
      state({ labels: ["triaged"], preReview: preReview({ expiresAt: null }) })
    );
    expect(unknown).toContain("deadline:** unavailable");
    expect(unknown).not.toContain("Invalid Date");
    const failed = getPrStatusMessage(
      state({
        labels: ["triaged"],
        preReview: preReview({ lookupFailed: true }),
      })
    );
    expect(failed).toContain("could not be checked yet");
    expect(failed).not.toContain("**Pre-review accepted:");
  });

  test("in progress explains maintainer feedback and CI readiness criteria", () => {
    const message = getPrStatusMessage(
      state({ labels: [PR_STATUS_LABEL_IN_PROGRESS] })
    );
    expect(message).toContain("The overall direction of the change is good.");
    expect(message).toContain("every maintainer comment must be addressed");
    expect(message).toContain("a reply explaining why no change is needed");
    expect(message).toContain(
      "Dr. CI must classify every failure as unrelated to your PR"
    );
    expect(message).toContain(
      "Workflows waiting for a maintainer to approve their run do not block this"
    );
    expect(message).toContain(
      "If you address comments without pushing, comment `@pytorchbot review`"
    );
  });

  test("an outstanding change request explains how to return to maintainer review", () => {
    const message = getPrStatusMessage(
      state({
        labels: [PR_STATUS_LABEL_IN_PROGRESS],
        hasChangesRequested: true,
      })
    );
    expect(message).toContain(
      "A maintainer requested changes. Please address their feedback before the PR returns to maintainer review."
    );
    expect(message).toContain(
      "A fresh automated review checks that the feedback has been addressed"
    );
    expect(message).toContain("the change must pass automated review");
    expect(message).not.toContain("The overall direction");
  });

  test("opted-out ready PRs keep maintainer review guidance after a change request", () => {
    const message = getPrStatusMessage(
      state({
        labels: [
          PR_STATUS_LABEL_READY_FOR_REVIEW,
          PR_STATUS_LABEL_REVIEW_OPT_OUT,
        ],
        hasChangesRequested: true,
      })
    );
    expect(message).toBe(
      "## PR Status: ready for maintainer review\n\n" +
        "A maintainer requested changes. Please address their feedback and ask for another review."
    );
  });

  test("ready for maintainer review", () => {
    expect(
      getPrStatusMessage(state({ labels: [PR_STATUS_LABEL_READY_FOR_REVIEW] }))
    ).toBe(
      "## PR Status: ready for maintainer review\n\n" +
        "Waiting for a maintainer with merge rights for the changed paths " +
        "to review this PR. Please address any feedback they leave."
    );
  });

  test("ready status names reviewers actually asked for re-review without mentions", () => {
    const message = getPrStatusMessage(
      state({
        labels: [PR_STATUS_LABEL_READY_FOR_REVIEW],
        hasChangesRequested: true,
        reReviewers: ["bob", "alice", "@unsafe"],
      })
    );
    expect(message).toContain("**Waiting for re-review:** `bob`, `alice`.");
    expect(message).toContain(
      "These reviewers have been asked to review the latest updates."
    );
    expect(message).not.toContain("@");
    expect(message).not.toContain("ask for another review");
  });

  test("missing actionable issue explains how to link one", () => {
    const message = getPrStatusMessage(
      state({
        labels: [
          PR_STATUS_LABEL_TRIAGED,
          PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE,
        ],
      })
    );
    expect(message).toMatch(/^## PR Status: missing actionable issue\n\n/);
    expect(message).toContain(
      "- a linked issue labeled `actionable` (`Fixes #<issue>` or `Part of #<issue>`); or\n"
    );
    expect(message).toContain(
      "- a maintainer named in the description who agreed to the change (`Supported by @<maintainer>`).\n"
    );
    expect(message).toContain(
      "Such PRs are a low priority for maintainers to review"
    );
    expect(message).toContain("add the matching line to the PR description");
    expect(message).toContain(
      "already-linked issue automatically requests re-triage"
    );
    expect(message).toContain(
      "Adding a valid actionable-issue link or `Supported by` line to the description also requests re-triage automatically."
    );
    expect(message).toContain("rechecks existing links and support");
    expect(message).toContain("then remove and re-add `open source`.");
  });

  test("needs additional approval", () => {
    const message = getPrStatusMessage(
      state({ isApproved: true, isMergeApproved: false })
    );
    expect(message).toBe(
      "## PR Status: Needs additional approval\n\n" +
        "This PR is missing an approval from someone with merge rights " +
        "for the code paths it changes."
    );
  });

  test("approved", () => {
    expect(getPrStatusMessage(state({ isApproved: true }))).toBe(
      "## PR Status: Approved 🚀\n\n" +
        "Please fix all CI failures and trigger " +
        'merge by commenting "@pytorchbot merge".'
    );
  });

  test("no assigned reviewers still has a deadline", () => {
    const message = getPrStatusMessage(
      state({
        labels: ["triaged"],
        preReview: preReview({
          assigned: [],
          agreed: [],
          pending: [],
          countedFrom: [],
        }),
      })
    );
    expect(message).toContain(
      "No reviewers are assigned; the shared deadline still applies."
    );
    expect(message).toContain("2026-11-05 16:30:00 UTC");
    expect(message).not.toContain("()");
  });

  test("reviewer names that did not come from GitHub are dropped", () => {
    const message = getPrStatusMessage(
      state({
        labels: ["triaged"],
        preReview: preReview({
          pending: ["alice", "](https://evil.example) [x", "bob"],
        }),
      })
    );
    expect(message).toContain("**Waiting for pre-review:** `alice`, `bob`.");
    expect(message).not.toContain("evil.example");
  });
});

describe("hasPrStatusLabel", () => {
  test("true only for enabled workflow labels", () => {
    expect(hasPrStatusLabel([])).toBe(false);
    expect(hasPrStatusLabel(["module: cuda"])).toBe(false);
    expect(hasPrStatusLabel(["module: cuda", PR_STATUS_LABEL_TRIAGED])).toBe(
      true
    );
    expect(hasPrStatusLabel([PR_STATUS_LABEL_IN_PROGRESS])).toBe(true);
    expect(hasPrStatusLabel([PR_STATUS_LABEL_READY_FOR_REVIEW])).toBe(true);
    expect(
      hasPrStatusLabel([
        PR_STATUS_LABEL_TRIAGED,
        PR_STATUS_LABEL_MISSING_ACTIONABLE_ISSUE,
      ])
    ).toBe(true);
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
    expect(section.startsWith(`${PR_STATUS_START}\n`)).toBe(true);
    expect(section.endsWith(`\n${PR_STATUS_END}\n`)).toBe(true);
    expect(section).toContain("## PR Status: in progress");
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

// Lets alice and greenlight approve anything, bob only docs, and dev-infra
// members CI.
const MERGE_RULES = `
- name: Documentation
  patterns: ["docs/**"]
  approved_by: [bob]
- name: OSS CI
  patterns: [".github/**"]
  approved_by: [pytorch/pytorch-dev-infra]
- name: Core Maintainers
  patterns: ["*"]
  approved_by: [alice]
- name: Greenlight Review Bot
  patterns: ["*"]
  approved_by: [pytorchgreenlight]
`;

function octokitStub({
  reviews = [] as any[],
  pull = {
    user: { login: "author" },
    requested_reviewers: [],
    requested_teams: [],
  } as any,
  reviewsError,
  pullError,
  files = ["torch/foo.py"],
  mergeRules = MERGE_RULES,
  mergeRulesError,
  teamMembers = [] as string[],
}: {
  reviews?: any[];
  pull?: any;
  reviewsError?: Error;
  pullError?: Error;
  files?: string[];
  mergeRules?: string;
  mergeRulesError?: Error;
  teamMembers?: string[];
} = {}) {
  const listReviews = jest.fn();
  const getContent = jest.fn(async () => {
    if (mergeRulesError) {
      throw mergeRulesError;
    }
    return { data: { content: Buffer.from(mergeRules).toString("base64") } };
  });
  const getMembershipForUserInOrg = jest.fn(
    async ({ username }: { username: string }) => {
      if (!teamMembers.includes(username)) {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }
      return { data: { state: "active" } };
    }
  );
  const get = jest.fn(async () => {
    if (pullError) {
      throw pullError;
    }
    return { data: pull };
  });
  const paginate = jest.fn(async (route: any) => {
    if (route !== listReviews) {
      return files.map((filename) => ({ filename }));
    }
    if (reviewsError) {
      throw reviewsError;
    }
    return reviews;
  });
  return {
    paginate,
    rest: {
      pulls: { listReviews, get },
      repos: { getContent },
      teams: { getMembershipForUserInOrg },
    },
    _get: get,
    _getContent: getContent,
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

  test("re-review lists only outstanding change requests with a current assignment", async () => {
    const review = (login: string, state: string, day = 1) => ({
      user: { login },
      state,
      author_association: "MEMBER",
      submitted_at: `2026-01-0${day}T00:00:00Z`,
    });
    const octokit = octokitStub({
      reviews: [
        review("alice", "CHANGES_REQUESTED"),
        review("alice", "COMMENTED", 2),
        review("bob", "CHANGES_REQUESTED"),
        review("cleared", "CHANGES_REQUESTED"),
        review("cleared", "DISMISSED", 2),
        review("author", "CHANGES_REQUESTED"),
        review("automation[bot]", "CHANGES_REQUESTED"),
      ],
      pull: {
        user: { login: "author" },
        requested_reviewers: [
          { login: "Alice" },
          { login: "cleared" },
          { login: "new-reviewer" },
          { login: "author" },
          { login: "automation[bot]" },
        ],
      },
    });
    const result = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "ready for review",
    ]);
    expect(result!.reReviewers).toEqual(["Alice"]);
  });

  test.each([
    ["a catch-all approver", ["alice"], ["torch/foo.py"], [], true],
    ["an approver of every changed file", ["bob"], ["docs/a.md"], [], true],
    [
      "an approver of only some files",
      ["bob"],
      ["docs/a.md", "torch/foo.py"],
      [],
      false,
    ],
    ["no listed approver", ["carol"], ["torch/foo.py"], [], false],
    [
      "a member of an approving team",
      ["carol"],
      [".github/x.yml"],
      ["carol"],
      true,
    ],
  ])(
    "checks the merge rules for %s",
    async (_, approvers, files, teamMembers, isMergeApproved) => {
      const octokit = octokitStub({
        reviews: approvers.map(approvingReview),
        files,
        teamMembers,
      });
      const state = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
        "in progress",
      ]);

      expect(state!.isApproved).toBe(true);
      expect(state!.isMergeApproved).toBe(isMergeApproved);
    }
  );

  test("matches greenlight's REST login to its merge rule login", async () => {
    const octokit = octokitStub({
      reviews: [
        {
          ...approvingReview("pytorchgreenlight[bot]"),
          author_association: "NONE",
        },
      ],
    });
    const state = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "in progress",
    ]);

    expect(state!.isApproved).toBe(true);
    expect(state!.isMergeApproved).toBe(true);
  });

  test("leaves the merge rule result unknown when the rules cannot be read", async () => {
    const octokit = octokitStub({
      reviews: [approvingReview("carol")],
      mergeRulesError: new Error("boom"),
    });
    const state = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "in progress",
    ]);

    expect(state!.isApproved).toBe(true);
    expect(state!.isMergeApproved).toBeUndefined();
    expect(state!.mergeApprovalLookupFailed).toBe(true);
    expect(getPrStatusStage(state!)).toBe("inProgress");
    expect(getPrStatusMessage(state!)).toContain(
      "merge eligibility could not be verified"
    );
  });

  test("does not read the merge rules without an approval", async () => {
    const octokit = octokitStub({ reviews: [] });
    const state = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "in progress",
    ]);

    expect(state!.isMergeApproved).toBeUndefined();
    expect(octokit._getContent).not.toHaveBeenCalled();
  });

  test("does not read the merge rules outside pytorch/pytorch", async () => {
    const octokit = octokitStub({ reviews: [approvingReview("carol")] });
    const state = await fetchPrStatusState(octokit, "pytorch", "vision", 1, [
      "in progress",
    ]);

    expect(state!.isApproved).toBe(true);
    expect(state!.isMergeApproved).toBeUndefined();
    expect(state!.mergeApprovalLookupFailed).toBe(false);
    expect(getPrStatusStage(state!)).toBe("approved");
    expect(octokit._getContent).not.toHaveBeenCalled();
  });

  test("reads metadata for non-triaged PRs without building the assigned reviewer list", async () => {
    const octokit = octokitStub({ reviews: [approvingReview("alice")] });
    const state = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "in progress",
    ]);

    expect(state!.isApproved).toBe(true);
    expect(state!.hasChangesRequested).toBe(false);
    expect(state!.assignedReviewers).toEqual([]);
    expect(octokit._get).toHaveBeenCalled();
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
    expect(state!.hasChangesRequested).toBe(true);
  });

  test.each(["APPROVED", "DISMISSED"])(
    "a later %s review clears the same reviewer's change request",
    async (reviewState) => {
      const octokit = octokitStub({
        reviews: [
          {
            ...approvingReview("alice"),
            state: "CHANGES_REQUESTED",
          },
          {
            ...approvingReview("alice"),
            state: reviewState,
            submitted_at: "2026-01-02T00:00:00Z",
          },
        ],
      });
      const result = await fetchPrStatusState(
        octokit,
        "pytorch",
        "pytorch",
        1,
        ["in progress"]
      );
      expect(result!.hasChangesRequested).toBe(false);
      expect(result!.isApproved).toBe(reviewState === "APPROVED");
    }
  );

  test("mere comments do not clear an outstanding change request", async () => {
    const octokit = octokitStub({
      reviews: [
        { ...approvingReview("alice"), state: "CHANGES_REQUESTED" },
        {
          ...approvingReview("alice"),
          state: "COMMENTED",
          submitted_at: "2026-01-02T00:00:00Z",
        },
      ],
    });
    const result = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "in progress",
    ]);
    expect(result!.hasChangesRequested).toBe(true);
  });

  test("an unauthorized change request does not set the flag", async () => {
    const octokit = octokitStub({
      reviews: [
        {
          ...approvingReview("drive-by"),
          state: "CHANGES_REQUESTED",
          author_association: "NONE",
        },
      ],
    });
    const result = await fetchPrStatusState(octokit, "pytorch", "pytorch", 1, [
      "in progress",
    ]);
    expect(result!.hasChangesRequested).toBe(false);
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

describe("fetchLiveLabels", () => {
  afterEach(() => {
    nock.cleanAll();
  });

  test("includes workflow opt-out labels from later pages", async () => {
    const labels = Array.from({ length: 100 }, (_, i) => ({
      name: `module: ${i}`,
    }));
    const scope = nock("https://api.github.com")
      .get("/repos/pytorch/pytorch/issues/1/labels")
      .query({ per_page: 100 })
      .reply(200, labels, {
        link: '<https://api.github.com/repos/pytorch/pytorch/issues/1/labels?per_page=100&page=2>; rel="next"',
      })
      .get("/repos/pytorch/pytorch/issues/1/labels")
      .query({ per_page: 100, page: 2 })
      .reply(200, [{ name: PR_STATUS_LABEL_REVIEW_OPT_OUT }]);

    const result = await fetchLiveLabels(
      new Octokit(),
      "pytorch",
      "pytorch",
      1
    );
    expect(result).toEqual([
      ...labels.map((label) => label.name),
      PR_STATUS_LABEL_REVIEW_OPT_OUT,
    ]);
    expect(scope.isDone()).toBe(true);
  });

  test("propagates label lookup failures so callers can preserve current status", async () => {
    const scope = nock("https://api.github.com")
      .get("/repos/pytorch/pytorch/issues/1/labels")
      .query({ per_page: 100 })
      .reply(403, { message: "Forbidden" });

    await expect(
      fetchLiveLabels(new Octokit(), "pytorch", "pytorch", 1)
    ).rejects.toMatchObject({ status: 403 });
    expect(scope.isDone()).toBe(true);
  });
});
