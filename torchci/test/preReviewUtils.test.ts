import {
  getPreReviewAcceptors,
  getPreReviewStatus,
  getRotatingBatch,
  getThumbsUpReactors,
  isInPreReview,
  markInProgressIfAccepted,
  updateInProgressLabels,
} from "lib/bot/preReviewUtils";
import pytorchBot from "lib/bot/pytorchBot";
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
    PR_STATUS_LABELS: [...actual.PR_STATUS_LABELS, "triaged"],
    PRE_REVIEW_START_DATE: "2026-01-01",
  };
});

const AUTHOR = "author";

function commented(login: string, body: string) {
  return { event: "commented", actor: { login }, user: { login }, body };
}

function thumbsUp(login: string) {
  return { content: "+1", user: { login } };
}

function mockPr({
  prNumber = 1,
  requested = [] as string[],
  teams = [] as string[],
  timeline = [] as object[],
  reactions = [] as object[],
}) {
  const scope = nock("https://api.github.com")
    .get(`/repos/pytorch/pytorch/pulls/${prNumber}/reviews?per_page=100`)
    .reply(200, [])
    .get(`/repos/pytorch/pytorch/issues/${prNumber}/timeline?per_page=100`)
    .reply(200, timeline)
    .get(
      `/repos/pytorch/pytorch/issues/${prNumber}/reactions?content=%2B1&per_page=100`
    )
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
    utils.mockAddLabels(["in progress"], "pytorch/pytorch", prNumber),
    nock("https://api.github.com")
      .delete(`/repos/pytorch/pytorch/issues/${prNumber}/labels/triaged`)
      .reply(200, []),
  ];
}

function mockTeam(slug: string, members: string[]) {
  return nock("https://api.github.com")
    .get(`/orgs/pytorch/teams/${slug}/members?per_page=100`)
    .reply(
      200,
      members.map((login) => ({ login }))
    );
}

afterEach(() => {
  nock.cleanAll();
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
      .reply(200, [])
      .get(
        "/repos/pytorch/pytorch/issues/1/reactions?content=%2B1&per_page=100"
      )
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
      countedFrom: ["alice", "carol"],
      accepted: true,
    });
    handleScope(scope);
  });
});

describe("markInProgressIfAccepted", () => {
  const octokit = utils.testOctokit();

  test("does not label a PR that is already in progress", async () => {
    const scope = mockPr({
      requested: ["alice"],
      reactions: [thumbsUp("alice")],
    });

    await markInProgressIfAccepted(
      octokit,
      "pytorch",
      "pytorch",
      1,
      ["triaged", "in progress"],
      AUTHOR
    );
    handleScope(scope);
  });
});

describe("updateInProgressLabels", () => {
  const octokit = utils.testOctokit();

  test("checks only thumbs-up PRs from the search and labels the accepted ones", async () => {
    const search = nock("https://api.github.com")
      .get("/search/issues")
      .query((query) => {
        expect(query.q).toContain("repo:pytorch/pytorch");
        expect(query.q).toContain('label:"triaged"');
        expect(query.q).toContain('-label:"in progress"');
        expect(query.q).toContain("created:>=2026-01-01");
        expect(query.q).toContain("reactions:>0");
        return true;
      })
      .reply(200, {
        total_count: 3,
        // PR 3 has reactions, but no thumbs-up, so it isn't checked
        items: [1, 2, 3].map((number) => ({
          number,
          user: { login: AUTHOR },
          labels: [{ name: "triaged" }],
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
    ];

    // A failed check is only logged, so catch requests for PRs that shouldn't
    // be checked this way
    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    await updateInProgressLabels(octokit, "pytorch", "pytorch");
    handleScope(scope);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
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

  function mockAck(event: any) {
    return nock("https://api.github.com")
      .post(
        `/repos/pytorch/pytorch/issues/comments/${event.payload.comment.id}/reactions`,
        (body) => {
          expect(body.content).toBe("+1");
          return true;
        }
      )
      .reply(200, {});
  }

  // Marks the PR for the scheduled run
  function mockReactToPr() {
    return nock("https://api.github.com")
      .post("/repos/pytorch/pytorch/issues/1/reactions", (body) => {
        expect(body.content).toBe("+1");
        return true;
      })
      .reply(200, {});
  }

  test("labels the PR when the last assigned reviewer accepts", async () => {
    const event = acceptEvent("alice");
    // The triggering comment isn't in the timeline yet
    const scope = [
      mockReactToPr(),
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
      mockReactToPr(),
      ...mockPr({ requested: ["bob"], teams: ["some-team"] }),
      mockTeam("some-team", ["carol"]),
      mockAck(event),
    ];

    await bot.receive(event);
    handleScope(scope);
  });

  test("ignores accepts from non-assigned commenters", async () => {
    const event = acceptEvent("alice");
    // An ack or reply would be an unmocked request and fail the test
    const scope = [mockReactToPr(), ...mockPr({ requested: ["bob"] })];

    await bot.receive(event);
    handleScope(scope);
  });

  test("ignores accepts on draft PRs", async () => {
    const event = acceptEvent("alice");
    event.payload.issue.draft = true;
    const scope = nock("https://api.github.com");

    await bot.receive(event);
    handleScope(scope);
  });
});
