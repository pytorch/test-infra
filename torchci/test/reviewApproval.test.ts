import {
  getApprovalStatusFromReviews,
  getReviewerLogins,
  PR_APPROVED,
  PR_CHANGES_REQUESTED,
} from "lib/reviewApproval";

let clock = 0;

function review(
  login: string,
  state: string,
  {
    association = "MEMBER",
    submitted_at,
  }: { association?: string; submitted_at?: string } = {}
): any {
  clock += 1;
  return {
    user: { login },
    state,
    author_association: association,
    submitted_at:
      submitted_at ?? `2026-01-01T00:00:${String(clock).padStart(2, "0")}Z`,
  };
}

beforeEach(() => {
  clock = 0;
});

describe("authorization", () => {
  test("an approval from someone with no relationship to the repo is ignored", () => {
    // Anyone can submit an approving review on a public PR.
    expect(
      getApprovalStatusFromReviews(
        [review("drive-by", "APPROVED", { association: "NONE" })],
        false
      )
    ).toBe("");
  });

  test.each(["COLLABORATOR", "CONTRIBUTOR", "MEMBER", "OWNER"])(
    "%s is an authorized approver",
    (association) => {
      expect(
        getApprovalStatusFromReviews(
          [review("alice", "APPROVED", { association })],
          false
        )
      ).toBe(PR_APPROVED);
    }
  );

  test("the greenlight bot is honored only when bots are allowed", () => {
    const reviews = [
      review("pytorchgreenlight[bot]", "APPROVED", { association: "NONE" }),
    ];
    expect(getApprovalStatusFromReviews(reviews, false)).toBe("");
    expect(getApprovalStatusFromReviews(reviews, true)).toBe(PR_APPROVED);
  });

  test("an arbitrary bot is not honored even when bots are allowed", () => {
    expect(
      getApprovalStatusFromReviews(
        [review("random[bot]", "APPROVED", { association: "NONE" })],
        true
      )
    ).toBe("");
  });
});

describe("per-reviewer decisions", () => {
  test("GitHub's uppercase state is matched despite the lowercase type", () => {
    expect(getApprovalStatusFromReviews([review("a", "APPROVED")], false)).toBe(
      PR_APPROVED
    );
    expect(getApprovalStatusFromReviews([review("a", "approved")], false)).toBe(
      PR_APPROVED
    );
  });

  test("a plain comment is not a decision and does not clear one", () => {
    expect(
      getApprovalStatusFromReviews(
        [review("a", "APPROVED"), review("a", "COMMENTED")],
        false
      )
    ).toBe(PR_APPROVED);
  });

  test("a dismissal clears that reviewer's standing approval", () => {
    expect(
      getApprovalStatusFromReviews(
        [review("a", "APPROVED"), review("a", "DISMISSED")],
        false
      )
    ).toBe("");
  });

  test("the latest decision per reviewer wins", () => {
    expect(
      getApprovalStatusFromReviews(
        [review("a", "CHANGES_REQUESTED"), review("a", "APPROVED")],
        false
      )
    ).toBe(PR_APPROVED);
    expect(
      getApprovalStatusFromReviews(
        [review("a", "APPROVED"), review("a", "CHANGES_REQUESTED")],
        false
      )
    ).toBe(PR_CHANGES_REQUESTED);
  });

  test("reviews are sorted by time, not trusted in list order", () => {
    const early = review("a", "APPROVED", {
      submitted_at: "2026-01-01T00:00:00Z",
    });
    const late = review("a", "CHANGES_REQUESTED", {
      submitted_at: "2026-01-02T00:00:00Z",
    });
    expect(getApprovalStatusFromReviews([late, early], false)).toBe(
      PR_CHANGES_REQUESTED
    );
  });

  test("a review with no user is skipped rather than throwing", () => {
    // The association check alone can pass for a review with a null user, and
    // the webhook path has no catch above this -- a throw would fail the
    // delivery outright.
    expect(() =>
      getApprovalStatusFromReviews(
        [
          {
            user: null,
            state: "APPROVED",
            author_association: "MEMBER",
            submitted_at: "2026-01-01T00:00:00Z",
          } as any,
        ],
        false
      )
    ).not.toThrow();
    expect(
      getApprovalStatusFromReviews(
        [
          {
            user: null,
            state: "DISMISSED",
            author_association: "MEMBER",
            submitted_at: "2026-01-01T00:00:00Z",
          } as any,
          review("a", "APPROVED"),
        ],
        false
      )
    ).toBe(PR_APPROVED);
  });

  test("does not mutate the caller's array", () => {
    const reviews = [
      review("a", "APPROVED", { submitted_at: "2026-01-02T00:00:00Z" }),
      review("b", "APPROVED", { submitted_at: "2026-01-01T00:00:00Z" }),
    ];
    const order = reviews.map((r) => r.user.login);
    getApprovalStatusFromReviews(reviews, false);
    expect(reviews.map((r) => r.user.login)).toEqual(order);
  });
});

describe("aggregation", () => {
  test("one approval is enough", () => {
    expect(
      getApprovalStatusFromReviews(
        [review("a", "COMMENTED"), review("b", "APPROVED")],
        false
      )
    ).toBe(PR_APPROVED);
  });

  test("any outstanding changes-requested beats an approval", () => {
    expect(
      getApprovalStatusFromReviews(
        [review("a", "APPROVED"), review("b", "CHANGES_REQUESTED")],
        false
      )
    ).toBe(PR_CHANGES_REQUESTED);
    // Order-independent: the approval arriving second must not win.
    expect(
      getApprovalStatusFromReviews(
        [review("a", "CHANGES_REQUESTED"), review("b", "APPROVED")],
        false
      )
    ).toBe(PR_CHANGES_REQUESTED);
  });

  test("no reviews means no verdict", () => {
    expect(getApprovalStatusFromReviews([], false)).toBe("");
  });
});

describe("getReviewerLogins", () => {
  test("dedupes, and keeps comment-only reviews from authorized reviewers", () => {
    // A comment review is exactly the case this recovers: GitHub drops that
    // reviewer from requested_reviewers, so without them the @-list would lose
    // a genuinely assigned reviewer for engaging with the PR.
    expect(
      getReviewerLogins([
        review("a", "APPROVED"),
        review("a", "COMMENTED"),
        review("b", "COMMENTED"),
      ])
    ).toEqual(["a", "b"]);
  });

  test("an unauthorized user cannot insert themselves into the reviewer list", () => {
    // Otherwise one review comment from any GitHub account is enough to be
    // named, permanently, in a bot-authored sentence about who must sign off.
    expect(
      getReviewerLogins([
        review("drive-by", "COMMENTED", { association: "NONE" }),
      ])
    ).toEqual([]);
  });

  test("the PR author is excluded even though they can leave comment reviews", () => {
    expect(
      getReviewerLogins(
        [review("author", "COMMENTED"), review("alice", "COMMENTED")],
        ["author"]
      )
    ).toEqual(["alice"]);
  });


  test("skips reviews with no user", () => {
    expect(
      getReviewerLogins([
        { state: "COMMENTED", author_association: "MEMBER" } as any,
      ])
    ).toEqual([]);
  });
});
