import {
  getPreReviewAcceptors,
  getPreReviewBatch,
  getPreReviewRejectors,
  getPreReviewStatus,
  getRotatingBatch,
  getThumbsUpReactors,
  hasPreReviewTimedOut,
  isInPreReview,
  markInProgressIfAccepted,
  updateInProgressLabels,
} from "lib/bot/preReviewUtils";
import pytorchBot from "lib/bot/pytorchBot";
import * as prStatus from "lib/prStatus";
import nock from "nock";
import * as probot from "probot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

// Turn on pre-review as if it has been rolled out
jest.mock("lib/prStatus", () => {
  const actual = jest.requireActual("lib/prStatus");
  return {
    ...actual,
    __esModule: true,
    PRE_REVIEW_START_DATE: "2026-01-01",
  };
});

const AUTHOR = "author";
const NOW = Date.parse("2026-10-26T12:00:00Z");
const ONE_WEEK_AGO = "2026-10-19T12:00:00Z";

function triaged(created_at = ONE_WEEK_AGO) {
  return { event: "labeled", label: { name: "triaged" }, created_at };
}

function commented(login: string, body: string) {
  return { event: "commented", actor: { login }, user: { login }, body };
}

function thumbsUp(login: string) {
  return { content: "+1", user: { login } };
}

function thumbsDown(login: string) {
  return { content: "-1", user: { login } };
}

function review(login: string, state: string, submitted_at = ONE_WEEK_AGO) {
  return { event: "reviewed", user: { login }, state, submitted_at };
}

function mockPr({
  prNumber = 1,
  requested = [] as string[],
  teams = [] as string[],
  timeline = [] as object[],
  reactions = [] as object[],
  triagedAt = new Date(NOW).toISOString(),
}) {
  const scope = nock("https://api.github.com")
    .get(`/repos/pytorch/pytorch/pulls/${prNumber}/reviews?per_page=100`)
    .reply(200, [])
    .get(`/repos/pytorch/pytorch/issues/${prNumber}/timeline?per_page=100`)
    .reply(200, [triaged(triagedAt), ...timeline])
    .get(`/repos/pytorch/pytorch/issues/${prNumber}/reactions?per_page=100`)
    .reply(200, reactions);
  return [
    scope,
    utils.mockGetPR("pytorch/pytorch", prNumber, {
      user: { login: AUTHOR },
      requested_reviewers: requested.map((login) => ({ login })),
      requested_teams: teams.map((slug) => ({ slug })),
    }),
  ];
}

function mockMoveToInProgress(prNumber: number = 1) {
  return [
    mockLivePr(prNumber),
    utils.mockAddLabels(["in progress"], "pytorch/pytorch", prNumber),
  ];
}

function mockLivePr(prNumber: number, overrides = {}) {
  return utils.mockGetPR("pytorch/pytorch", prNumber, {
    state: "open",
    draft: false,
    created_at: "2026-02-01T00:00:00Z",
    labels: [{ name: "triaged" }],
    ...overrides,
  });
}

function mockTeam(slug: string, members: string[]) {
  return nock("https://api.github.com")
    .get(`/orgs/pytorch/teams/${slug}/members?per_page=100`)
    .reply(
      200,
      members.map((login) => ({ login }))
    );
}

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  nock.cleanAll();
  jest.restoreAllMocks();
});

describe("hasPreReviewTimedOut", () => {
  test("expires at exactly seven days, independent of subsequent activity", () => {
    const events = [
      triaged(),
      { event: "review_requested", created_at: new Date(NOW).toISOString() },
      { event: "committed", created_at: new Date(NOW).toISOString() },
    ];
    expect(hasPreReviewTimedOut(events, NOW - 1)).toBe(false);
    expect(hasPreReviewTimedOut(events, NOW)).toBe(true);
    expect(hasPreReviewTimedOut(events, NOW + 1)).toBe(true);
  });

  test("uses the latest triage, regardless of timeline ordering", () => {
    expect(hasPreReviewTimedOut([triaged(), triaged("2026-01-01")], NOW)).toBe(
      true
    );
    expect(hasPreReviewTimedOut([triaged("2026-10-25"), triaged()], NOW)).toBe(
      false
    );
  });

  test("missing or invalid triage dates cannot trigger a timeout", () => {
    expect(hasPreReviewTimedOut([], NOW)).toBe(false);
    expect(hasPreReviewTimedOut([triaged("invalid")], NOW)).toBe(false);
    expect(hasPreReviewTimedOut([triaged(), triaged("invalid")], NOW)).toBe(
      false
    );
  });

  test.each([
    { event: "ready_for_review" },
    { event: "unlabeled", label: { name: "missing actionable issue" } },
  ])("restarts when a PR re-enters pre-review: %j", (event) => {
    const resumed = { ...event, created_at: new Date(NOW).toISOString() };
    const events = [triaged(), resumed];
    const week = 7 * 24 * 60 * 60 * 1000;
    expect(hasPreReviewTimedOut(events, NOW)).toBe(false);
    expect(hasPreReviewTimedOut(events, NOW + week - 1)).toBe(false);
    expect(hasPreReviewTimedOut(events, NOW + week)).toBe(true);
    // Returning to ready doesn't itself replace triage.
    expect(hasPreReviewTimedOut([resumed], NOW + week)).toBe(false);
  });
});

describe("getPreReviewRejectors", () => {
  test("thumbs-down remains an objection even alongside an acceptance", () => {
    expect(
      getPreReviewRejectors(
        [commented("alice", "@pytorchbot pre-review accept")],
        [thumbsUp("alice"), thumbsDown("alice"), { content: "-1", user: null }]
      )
    ).toEqual(new Set(["alice"]));
  });

  test("only approval or dismissal clears a request for changes", () => {
    expect(
      getPreReviewRejectors(
        [
          review("alice", "COMMENTED", "2026-10-22T12:00:00Z"),
          review("alice", "CHANGES_REQUESTED"),
          review("bob", "changes_requested"),
          review("bob", "approved", "2026-10-22T12:00:00Z"),
          review("carol", "CHANGES_REQUESTED"),
          review("carol", "DISMISSED", "2026-10-22T12:00:00Z"),
        ],
        []
      )
    ).toEqual(new Set(["alice"]));
  });
});

describe("getPreReviewAcceptors", () => {
  test("counts accept comments and reviews", () => {
    const events = [
      commented("alice", "Looks worth doing\n@pytorchbot pre-review accept"),
      {
        event: "reviewed",
        user: { login: "bob" },
        body: "@pytorchbot pre-review accept",
      },
      commented("carol", "@pytorchbot merge"),
      commented("dave", "I'll pre-review accept this later"),
      commented("erin", "@pytorchbot pre-review accept -h"),
      commented("frank", "@pytorchbot pre-review accept now"),
    ];
    expect(getPreReviewAcceptors(events)).toEqual(new Set(["alice", "bob"]));
  });
});

describe("isInPreReview", () => {
  test("only applies to open, non-draft PRs created after rollout", () => {
    const pr = {
      state: "open",
      draft: false,
      created_at: "2026-02-01T00:00:00Z",
    };
    expect(isInPreReview(pr)).toBe(true);
    expect(isInPreReview({ ...pr, state: "closed" })).toBe(false);
    expect(isInPreReview({ ...pr, draft: true })).toBe(false);
    expect(isInPreReview({ ...pr, created_at: "2025-12-31T00:00:00Z" })).toBe(
      false
    );
  });
});

describe("getRotatingBatch", () => {
  test("checks a different batch each run and wraps around", () => {
    const items = [1, 2, 3, 4, 5];
    expect(getRotatingBatch(items, 0, 2)).toEqual([1, 2]);
    expect(getRotatingBatch(items, 1, 2)).toEqual([3, 4]);
    expect(getRotatingBatch(items, 2, 2)).toEqual([5, 1]);
    expect(getRotatingBatch(items, 0, 10)).toEqual(items);
  });
});

describe("getPreReviewBatch", () => {
  test("checks every potential timeout even when the batch limit is exceeded", () => {
    const old = Array.from({ length: 150 }, (_, number) => ({
      number,
      created_at: ONE_WEEK_AGO,
    }));
    const young = Array.from({ length: 150 }, (_, number) => ({
      number: 150 + number,
      created_at: new Date(NOW).toISOString(),
    }));
    const batch = getPreReviewBatch([...young, ...old], NOW);
    expect(batch.slice(0, old.length)).toEqual(old);
    expect(batch.length).toBe(250);
  });
});

describe("getThumbsUpReactors", () => {
  test("only counts thumbs-up reactions", () => {
    const reactions = [
      thumbsUp("alice"),
      { content: "heart", user: { login: "bob" } },
      { content: "+1", user: null },
    ];
    expect(getThumbsUpReactors(reactions)).toEqual(new Set(["alice"]));
  });
});

describe("getPreReviewStatus", () => {
  const octokit = utils.testOctokit();

  async function getStatus() {
    return await getPreReviewStatus(
      octokit,
      "pytorch",
      "pytorch",
      1,
      ["triaged"],
      AUTHOR
    );
  }

  test("accept comments count the same as reactions", async () => {
    const scope = mockPr({
      requested: ["alice", "bob"],
      timeline: [commented("bob", "@pytorchbot pre-review accept")],
      reactions: [thumbsUp("alice")],
    });

    expect((await getStatus()).accepted).toBe(true);
    handleScope(scope);
  });

  test("not accepted when no reviewers are assigned", async () => {
    const scope = mockPr({ reactions: [thumbsUp("alice")] });

    expect(await getStatus()).toMatchObject({
      assigned: [],
      accepted: false,
    });
    handleScope(scope);
  });

  test("not accepted when the PR lookup fails", async () => {
    // Without the PR, bob's pending review request would be missed
    const scope = nock("https://api.github.com")
      .get("/repos/pytorch/pytorch/pulls/1/reviews?per_page=100")
      .reply(200, [
        {
          user: { login: "alice" },
          state: "COMMENTED",
          author_association: "MEMBER",
          submitted_at: "2026-09-01T00:00:00Z",
          body: "",
        },
      ])
      .get("/repos/pytorch/pytorch/issues/1/timeline?per_page=100")
      .reply(200, [triaged()])
      .get("/repos/pytorch/pytorch/issues/1/reactions?per_page=100")
      .reply(200, [thumbsUp("alice")])
      .get("/repos/pytorch/pytorch/pulls/1")
      .reply(500);

    expect((await getStatus()).accepted).toBe(false);
    handleScope(scope);
  });

  test("a team agrees once any member reacts", async () => {
    const scope = [
      ...mockPr({
        requested: ["alice"],
        teams: ["some-team"],
        reactions: [thumbsUp("alice"), thumbsUp("carol")],
      }),
      mockTeam("some-team", ["bob", "carol"]),
    ];

    expect(await getStatus()).toEqual({
      assigned: ["alice", "pytorch/some-team"],
      agreed: ["alice", "pytorch/some-team"],
      pending: [],
      timedOut: [],
      rejected: [],
      isMergeApproved: false,
      lookupFailed: false,
      countedFrom: ["alice", "carol"],
      accepted: true,
    });
    handleScope(scope);
  });

  test.each([NOW - 1, NOW, NOW + 1])(
    "silent reviewers at time %s",
    async (now) => {
      jest.spyOn(Date, "now").mockReturnValue(now);
      const scope = mockPr({
        requested: ["alice", "bob"],
        triagedAt: ONE_WEEK_AGO,
        reactions: [thumbsUp("alice")],
      });
      expect(await getStatus()).toMatchObject({
        agreed: ["alice"],
        timedOut: now >= NOW ? ["bob"] : [],
        pending: now >= NOW ? [] : ["bob"],
        countedFrom: ["alice"],
        accepted: now >= NOW,
      });
      handleScope(scope);
    }
  );

  test("entirely silent PRs, including unassigned PRs, expire", async () => {
    for (const requested of [["alice", "bob"], []]) {
      const scope = mockPr({ requested, triagedAt: ONE_WEEK_AGO });
      expect(await getStatus()).toMatchObject({
        agreed: [],
        timedOut: requested,
        pending: [],
        countedFrom: [],
        accepted: true,
      });
      handleScope(scope);
    }
  });

  test.each([
    { reactions: [thumbsDown("bob")] },
    { timeline: [review("bob", "CHANGES_REQUESTED")] },
    { reactions: [thumbsUp("bob"), thumbsDown("bob")] },
  ])("explicit objections never time out: %j", async (response) => {
    const scope = mockPr({
      requested: ["alice", "bob"],
      triagedAt: ONE_WEEK_AGO,
      ...response,
    });
    expect(await getStatus()).toMatchObject({
      timedOut: ["alice"],
      rejected: ["bob"],
      pending: ["bob"],
      accepted: false,
    });
    handleScope(scope);
  });

  test("unassigned people and the author cannot veto a timeout", async () => {
    const scope = mockPr({
      requested: ["alice"],
      triagedAt: ONE_WEEK_AGO,
      reactions: [thumbsDown("outsider"), thumbsDown(AUTHOR)],
    });
    expect((await getStatus()).accepted).toBe(true);
    handleScope(scope);
  });

  test("a silent team times out", async () => {
    const scope = [
      ...mockPr({ teams: ["some-team"], triagedAt: ONE_WEEK_AGO }),
      mockTeam("some-team", ["bob", "carol"]),
    ];
    expect(await getStatus()).toMatchObject({
      timedOut: ["pytorch/some-team"],
      accepted: true,
    });
    handleScope(scope);
  });

  test("a team member's objection blocks acceptance by another member", async () => {
    const scope = [
      ...mockPr({
        teams: ["some-team"],
        triagedAt: ONE_WEEK_AGO,
        reactions: [thumbsUp("bob"), thumbsDown("carol")],
      }),
      mockTeam("some-team", ["bob", "carol"]),
    ];
    expect(await getStatus()).toMatchObject({
      rejected: ["pytorch/some-team"],
      accepted: false,
    });
    handleScope(scope);
  });

  test("failed team lookups do not hide objections after the deadline", async () => {
    const scope = [
      ...mockPr({ teams: ["some-team"], triagedAt: ONE_WEEK_AGO }),
      nock("https://api.github.com")
        .get("/orgs/pytorch/teams/some-team/members?per_page=100")
        .reply(500),
    ];
    expect(await getStatus()).toMatchObject({
      pending: ["pytorch/some-team"],
      timedOut: [],
      accepted: false,
    });
    handleScope(scope);
  });

  test.each([
    { mergeApproved: true, reacted: true, expired: false, accepted: false },
    { mergeApproved: true, reacted: false, expired: true, accepted: false },
    { mergeApproved: false, reacted: true, expired: false, accepted: true },
    { mergeApproved: false, reacted: false, expired: false, accepted: false },
    { mergeApproved: false, reacted: false, expired: true, accepted: true },
    { mergeApproved: undefined, reacted: false, expired: true, accepted: true },
  ])(
    "only verified merge-rules approvals end pre-review: %j",
    async ({ mergeApproved, reacted, expired, accepted }) => {
      const scope = nock("https://api.github.com")
        .get("/repos/pytorch/pytorch/issues/1/timeline?per_page=100")
        .reply(200, [
          triaged(expired ? ONE_WEEK_AGO : new Date(NOW).toISOString()),
        ])
        .get("/repos/pytorch/pytorch/issues/1/reactions?per_page=100")
        .reply(200, reacted ? [thumbsUp("bob")] : []);
      const status = await getPreReviewStatus(
        octokit,
        "pytorch",
        "pytorch",
        1,
        ["triaged"],
        AUTHOR,
        [],
        {
          labels: ["triaged"],
          assignedReviewers: ["bob"],
          isApproved: true,
          isMergeApproved: mergeApproved,
        }
      );
      expect(status.accepted).toBe(accepted);
      expect(status.isMergeApproved).toBe(mergeApproved === true);
      handleScope(scope);
    }
  );
});

describe("markInProgressIfAccepted", () => {
  const octokit = utils.testOctokit();

  test("reads with the pre-review app and only writes labels with PyTorchBot", async () => {
    const labeler = utils.testOctokit();
    const readerWrites = jest.spyOn(octokit.rest.issues, "addLabels");
    const labelerReads = jest.spyOn(labeler, "paginate");
    const labelerPullReads = jest.spyOn(labeler.rest.pulls, "get");
    const scope = [
      ...mockPr({ requested: ["bob"], triagedAt: ONE_WEEK_AGO }),
      ...mockMoveToInProgress(),
    ];
    await markInProgressIfAccepted(
      octokit,
      labeler,
      "pytorch",
      "pytorch",
      1,
      ["triaged"],
      AUTHOR
    );
    handleScope(scope);
    expect(readerWrites).not.toHaveBeenCalled();
    expect(labelerReads).not.toHaveBeenCalled();
    expect(labelerPullReads).not.toHaveBeenCalled();
  });

  test("does not label a PR that is already in progress", async () => {
    const scope = mockPr({
      requested: ["alice"],
      reactions: [thumbsUp("alice")],
    });

    await markInProgressIfAccepted(
      octokit,
      octokit,
      "pytorch",
      "pytorch",
      1,
      ["triaged", "in progress"],
      AUTHOR
    );
    handleScope(scope);
  });

  test("does not label a PR that is already ready for review", async () => {
    const scope = mockPr({
      requested: ["alice"],
      reactions: [thumbsUp("alice")],
    });

    await markInProgressIfAccepted(
      octokit,
      octokit,
      "pytorch",
      "pytorch",
      1,
      ["triaged", "ready for review"],
      AUTHOR
    );
    handleScope(scope);
  });

  test.each([
    { state: "closed" },
    { draft: true },
    { created_at: "2025-01-01T00:00:00Z" },
    { labels: [] },
    { labels: [{ name: "triaged" }, { name: "in progress" }] },
    { labels: [{ name: "triaged" }, { name: "ready for review" }] },
    { labels: [{ name: "triaged" }, { name: "missing actionable issue" }] },
  ])(
    "rechecks live eligibility before advancing an expired PR: %j",
    async (live) => {
      const scope = [
        ...mockPr({ requested: ["alice"], triagedAt: ONE_WEEK_AGO }),
        mockLivePr(1, live),
      ];
      await markInProgressIfAccepted(
        octokit,
        octokit,
        "pytorch",
        "pytorch",
        1,
        ["triaged"],
        AUTHOR
      );
      handleScope(scope);
    }
  );
});

describe("updateInProgressLabels", () => {
  const octokit = utils.testOctokit();

  function search(updatedAt = ONE_WEEK_AGO) {
    return nock("https://api.github.com")
      .get("/search/issues")
      .query(true)
      .reply(200, {
        total_count: 1,
        items: [
          {
            number: 1,
            created_at: ONE_WEEK_AGO,
            updated_at: updatedAt,
            user: { login: AUTHOR },
            labels: [{ name: "triaged" }],
          },
        ],
      });
  }

  test("backs off explicit objections across runs, then notices a removed reaction without an event", async () => {
    const scope = [
      search(),
      ...mockPr({
        requested: ["bob"],
        triagedAt: ONE_WEEK_AGO,
        reactions: [thumbsDown("bob")],
      }),
    ];
    const first = await updateInProgressLabels(
      octokit,
      octokit,
      "pytorch",
      "pytorch"
    );
    handleScope(scope);
    expect(first.checked).toBe(1);
    expect(first.rechecks[1].nextCheckAt).toBe(NOW + 6 * 60 * 60 * 1000);

    // Only search runs on the next invocation: no review/timeline/team reads.
    const secondScope = search();
    const second = await updateInProgressLabels(
      octokit,
      octokit,
      "pytorch",
      "pytorch",
      first.rechecks
    );
    handleScope(secondScope);
    expect(second).toMatchObject({
      checked: 0,
      deferred: 1,
      rechecks: first.rechecks,
    });

    jest.spyOn(Date, "now").mockReturnValue(first.rechecks[1].nextCheckAt);
    const thirdScope = [
      search(),
      ...mockPr({ requested: ["bob"], triagedAt: ONE_WEEK_AGO }),
      ...mockMoveToInProgress(),
    ];
    const third = await updateInProgressLabels(
      octokit,
      octokit,
      "pytorch",
      "pytorch",
      second.rechecks
    );
    handleScope(thirdScope);
    expect(third).toEqual({
      checked: 1,
      deferred: 0,
      rechecks: {},
      failed: [],
    });
  });

  test("an updated PR bypasses the blocked retry delay", async () => {
    const scope = [
      search(new Date(NOW).toISOString()),
      ...mockPr({ requested: ["bob"], triagedAt: ONE_WEEK_AGO }),
      ...mockMoveToInProgress(),
    ];
    const result = await updateInProgressLabels(
      octokit,
      octokit,
      "pytorch",
      "pytorch",
      {
        1: { updatedAt: ONE_WEEK_AGO, nextCheckAt: NOW + 6 * 60 * 60 * 1000 },
      }
    );
    handleScope(scope);
    expect(result).toEqual({
      checked: 1,
      deferred: 0,
      rechecks: {},
      failed: [],
    });
  });

  test("never backs off silent reviewers before their deadline", async () => {
    const scope = [search(), ...mockPr({ requested: ["bob"] })];
    const result = await updateInProgressLabels(
      octokit,
      octokit,
      "pytorch",
      "pytorch"
    );
    handleScope(scope);
    expect(result.rechecks).toEqual({});
    expect(result.failed).toEqual([]);
  });

  test("backs off a verified merge approval without excluding other approvals from search", async () => {
    jest.spyOn(prStatus, "fetchPrStatusState").mockResolvedValue({
      labels: ["triaged"],
      assignedReviewers: ["bob"],
      isApproved: true,
      isMergeApproved: true,
    });
    const scope = [
      search(),
      nock("https://api.github.com")
        .get("/repos/pytorch/pytorch/issues/1/timeline?per_page=100")
        .reply(200, [triaged()])
        .get("/repos/pytorch/pytorch/issues/1/reactions?per_page=100")
        .reply(200, []),
    ];
    const result = await updateInProgressLabels(
      octokit,
      octokit,
      "pytorch",
      "pytorch"
    );
    handleScope(scope);
    expect(result.rechecks[1]).toEqual({
      updatedAt: ONE_WEEK_AGO,
      nextCheckAt: NOW + 6 * 60 * 60 * 1000,
    });
    expect(result.failed).toEqual([]);
  });

  test("a failed lookup is retried on the next sweep", async () => {
    const scope = [
      search(),
      nock("https://api.github.com")
        .get("/repos/pytorch/pytorch/pulls/1/reviews?per_page=100")
        .reply(200, [])
        .get("/repos/pytorch/pytorch/pulls/1")
        .reply(500)
        .get("/repos/pytorch/pytorch/issues/1/timeline?per_page=100")
        .reply(200, [triaged()])
        .get("/repos/pytorch/pytorch/issues/1/reactions?per_page=100")
        .reply(200, []),
    ];
    const result = await updateInProgressLabels(
      octokit,
      octokit,
      "pytorch",
      "pytorch"
    );
    handleScope(scope);
    expect(result.rechecks).toEqual({});
    expect(result.failed).toEqual([1]);
  });

  test("checks PRs without reactions and labels expired ones on the scheduled sweep", async () => {
    const search = nock("https://api.github.com")
      .get("/search/issues")
      .query((query) => {
        expect(query.q).toContain("repo:pytorch/pytorch");
        expect(query.q).toContain('label:"triaged"');
        expect(query.q).toContain('-label:"in progress"');
        expect(query.q).toContain('-label:"ready for review"');
        expect(query.q).toContain('-label:"missing actionable issue"');
        expect(query.q).toContain("created:2026-01-01T00:00:00.000Z..");
        expect(query.q).not.toContain("reactions:");
        expect(query.q).not.toContain("-review:approved");
        return true;
      })
      .reply(200, {
        total_count: 3,
        // PR 3 has no reactions or recent activity but has reached its deadline.
        items: [1, 2, 3].map((number) => ({
          number,
          user: { login: AUTHOR },
          labels: [{ name: "triaged" }],
          created_at: ONE_WEEK_AGO,
          reactions: { "+1": number === 3 ? 0 : 1 },
        })),
      });
    const scope = [
      search,
      ...mockPr({
        prNumber: 1,
        requested: ["alice"],
        reactions: [thumbsUp("alice")],
      }),
      ...mockMoveToInProgress(1),
      ...mockPr({ prNumber: 2, requested: ["alice"] }),
      ...mockPr({ prNumber: 3, requested: ["alice"], triagedAt: ONE_WEEK_AGO }),
      ...mockMoveToInProgress(3),
    ];

    // A failed check is only logged, so catch requests for PRs that shouldn't
    // be checked this way
    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    await updateInProgressLabels(octokit, octokit, "pytorch", "pytorch");
    handleScope(scope);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  test("splits searches above 1,000 results and reads every page", async () => {
    const since = Date.parse("2026-01-01") / 1000;
    const until = NOW / 1000;
    const middle = Math.floor((since + until) / 2);
    const range = (start: number, end: number) =>
      `created:${new Date(start * 1000).toISOString()}..${new Date(
        end * 1000
      ).toISOString()}`;
    const root = range(since, until);
    const left = range(since, middle);
    const right = range(middle + 1, until);
    const scope = [
      nock("https://api.github.com")
        .get("/search/issues")
        .query(true)
        .times(12)
        .reply((uri) => {
          const params = new URL(uri, "https://api.github.com").searchParams;
          const query = params.get("q")!;
          if (query.includes(root)) {
            return [200, { total_count: 1001, items: [] }];
          }
          if (query.includes(left)) {
            const page = Number(params.get("page") ?? 1);
            expect(page).toBeLessThanOrEqual(10);
            // Deleted authors are skipped, except the last PR on page 10.
            return [
              200,
              {
                total_count: 1000,
                items: Array.from({ length: 100 }, (_, index) => ({
                  number: (page - 1) * 100 + index + 1,
                  created_at: ONE_WEEK_AGO,
                  labels: [{ name: "triaged" }],
                  user: page === 10 && index === 99 ? { login: AUTHOR } : null,
                })),
              },
            ];
          }
          expect(query).toContain(right);
          return [
            200,
            {
              total_count: 1,
              items: [
                {
                  number: 1001,
                  created_at: ONE_WEEK_AGO,
                  labels: [{ name: "triaged" }],
                  user: { login: AUTHOR },
                },
              ],
            },
          ];
        }),
      ...mockPr({
        prNumber: 1000,
        requested: ["alice"],
        triagedAt: ONE_WEEK_AGO,
      }),
      ...mockMoveToInProgress(1000),
      ...mockPr({
        prNumber: 1001,
        requested: ["bob"],
        triagedAt: ONE_WEEK_AGO,
      }),
      ...mockMoveToInProgress(1001),
    ];
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    await updateInProgressLabels(octokit, octokit, "pytorch", "pytorch");
    handleScope(scope);
    expect(error).not.toHaveBeenCalled();
  });

  test("one failed PR does not prevent another PR's timeout", async () => {
    const scope = [
      nock("https://api.github.com")
        .get("/search/issues")
        .query(true)
        .reply(200, {
          total_count: 2,
          items: [1, 2].map((number) => ({
            number,
            created_at: ONE_WEEK_AGO,
            user: { login: AUTHOR },
            labels: [{ name: "triaged" }],
          })),
        })
        .get("/repos/pytorch/pytorch/pulls/1/reviews?per_page=100")
        .reply(200, [])
        .get("/repos/pytorch/pytorch/issues/1/timeline?per_page=100")
        .reply(500)
        .get("/repos/pytorch/pytorch/issues/1/reactions?per_page=100")
        .reply(200, []),
      utils.mockGetPR("pytorch/pytorch", 1, { user: { login: AUTHOR } }),
      ...mockPr({ prNumber: 2, requested: ["alice"], triagedAt: ONE_WEEK_AGO }),
      ...mockMoveToInProgress(2),
    ];
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    await updateInProgressLabels(octokit, octokit, "pytorch", "pytorch");
    handleScope(scope);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("pytorch/pytorch#1");
  });
});

describe("pre-review accept command", () => {
  let bot: probot.Probot;

  beforeEach(() => {
    bot = utils.testProbot();
    bot.load(pytorchBot);
  });

  function acceptEvent(commenter: string) {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "@pytorchbot pre-review accept";
    event.payload.comment.user.login = commenter;
    event.payload.issue.number = 1;
    event.payload.issue.user.login = AUTHOR;
    event.payload.issue.labels = [{ name: "triaged" }];
    event.payload.issue.created_at = "2026-02-01T00:00:00Z";
    event.payload.repository.owner.login = "pytorch";
    event.payload.repository.name = "pytorch";
    event.payload.repository.full_name = "pytorch/pytorch";
    return event;
  }

  function mockReactToComment(event: any, content: "+1" | "-1") {
    return nock("https://api.github.com")
      .post(
        `/repos/pytorch/pytorch/issues/comments/${event.payload.comment.id}/reactions`,
        (body) => {
          expect(body.content).toBe(content);
          return true;
        }
      )
      .reply(200, {});
  }

  function mockAck(event: any) {
    return mockReactToComment(event, "+1");
  }

  function mockReject(event: any) {
    return mockReactToComment(event, "-1");
  }

  test("labels the PR when the last assigned reviewer accepts", async () => {
    const event = acceptEvent("alice");
    // The triggering comment isn't in the timeline yet
    const scope = [
      ...mockPr({ requested: ["alice", "bob"], reactions: [thumbsUp("bob")] }),
      ...mockMoveToInProgress(),
      mockAck(event),
    ];

    await bot.receive(event);
    handleScope(scope);
  });

  test("acknowledges a member of an assigned team", async () => {
    const event = acceptEvent("carol");
    const scope = [
      ...mockPr({ requested: ["bob"], teams: ["some-team"] }),
      mockTeam("some-team", ["carol"]),
      mockAck(event),
    ];

    await bot.receive(event);
    handleScope(scope);
  });

  test("rejects accepts from non-assigned commenters", async () => {
    const event = acceptEvent("alice");
    const scope = [...mockPr({ requested: ["bob"] }), mockReject(event)];

    await bot.receive(event);
    handleScope(scope);
  });

  test("rejects accepts on draft PRs", async () => {
    const event = acceptEvent("alice");
    event.payload.issue.draft = true;
    const scope = mockReject(event);

    await bot.receive(event);
    handleScope(scope);
  });

  test("rejects an invalid pre-review command", async () => {
    const event = acceptEvent("alice");
    event.payload.comment.body = "@pytorchbot pre-review accept now";
    const scope = [
      mockReject(event),
      nock("https://api.github.com")
        .post("/repos/pytorch/pytorch/issues/1/comments", (body) => {
          expect(body.body).toContain("pytorchbot command failed");
          return true;
        })
        .reply(200, {}),
    ];

    await bot.receive(event);
    handleScope(scope);
  });
});
