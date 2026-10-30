import { requestOutstandingChangesReviewers } from "lib/prReview/reReviewRequests";
import {
  getOutstandingChangesReviewers,
  ReReviewReview,
} from "lib/reviewApproval";
import nock from "nock";
import { handleScope } from "./common";
import { testOctokit } from "./utils";

nock.disableNetConnect();

const BEFORE = "2026-10-01T11:00:00Z";
const IN_PROGRESS = "2026-10-01T12:00:00Z";
const AFTER = "2026-10-01T13:00:00Z";
const LATER = "2026-10-01T14:00:00Z";
const TRANSITION = {
  id: 10,
  event: "labeled",
  label: { name: "in progress" },
  created_at: IN_PROGRESS,
};

function review(
  login: string,
  state = "CHANGES_REQUESTED",
  submitted_at = BEFORE
): ReReviewReview {
  return { user: { login }, state, submitted_at };
}

afterEach(() => {
  nock.cleanAll();
});

describe("getOutstandingChangesReviewers", () => {
  test("comments preserve requests, approvals and dismissals clear them, and order and casing do not matter", () => {
    expect(
      getOutstandingChangesReviewers(
        [
          review("alice", "COMMENTED", AFTER),
          review("bob", "APPROVED", AFTER),
          review("carol", "DISMISSED", AFTER),
          review("dave", "changes_requested", AFTER),
          review("Alice"),
          review("bob"),
          review("carol"),
          review("dave", "APPROVED"),
          review("erin", "PENDING", AFTER),
        ],
        "author"
      )
    ).toEqual(["Alice", "dave"]);
  });

  test("excludes the author, bots, and deleted users", () => {
    expect(
      getOutstandingChangesReviewers(
        [
          review("Author"),
          review("some-app[bot]"),
          review("pytorchmergebot"),
          { ...review("app"), user: { login: "app", type: "Bot" } },
          { ...review("deleted"), user: null },
          review("human"),
        ],
        "author"
      )
    ).toEqual(["human"]);
  });

  test("uses review IDs to order decisions submitted in the same second", () => {
    expect(
      getOutstandingChangesReviewers(
        [
          { ...review("alice", "APPROVED"), id: 2 },
          { ...review("alice"), id: 1 },
        ],
        "author"
      )
    ).toEqual([]);
  });
});

describe("requestOutstandingChangesReviewers", () => {
  const octokit = testOctokit();
  const api = () => nock("https://api.github.com");
  const request = (reviews?: ReReviewReview[]) =>
    requestOutstandingChangesReviewers(
      octokit,
      "pytorch",
      "pytorch",
      1,
      "author",
      reviews
    );

  function mockState(events: object[] = [TRANSITION], users: string[] = []) {
    return api()
      .get("/repos/pytorch/pytorch/issues/1/timeline?per_page=100")
      .reply(200, events)
      .get("/repos/pytorch/pytorch/pulls/1/requested_reviewers?per_page=100")
      .reply(200, { users: users.map((login) => ({ login })), teams: [] });
  }

  function mockPermission(login: string, role = "write") {
    return api()
      .get(`/repos/pytorch/pytorch/collaborators/${login}/permission`)
      .reply(200, { role_name: role });
  }

  function mockRequest(reviewers: string[], status = 201) {
    return api()
      .post("/repos/pytorch/pytorch/pulls/1/requested_reviewers", { reviewers })
      .reply(status, {});
  }

  test("requests only outstanding humans with current maintainer privileges", async () => {
    const scopes = [
      mockState(),
      mockPermission("alice", "triage"),
      mockPermission("bob", "read"),
      mockRequest(["alice"]),
    ];
    expect(
      await request([
        review("alice"),
        review("bob"),
        review("author"),
        review("pytorchmergebot"),
        review("carol"),
        review("carol", "APPROVED", AFTER),
      ])
    ).toEqual(["alice"]);
    handleScope(scopes);
  });

  test("fetches reviews when the caller has not already read them", async () => {
    const scopes = [
      api()
        .get("/repos/pytorch/pytorch/pulls/1/reviews?per_page=100")
        .reply(200, [review("alice")]),
      mockState(),
      mockPermission("alice"),
      mockRequest(["alice"]),
    ];
    expect(await request()).toEqual(["alice"]);
    handleScope(scopes);
  });

  test("makes no additional API calls when there are no outstanding human changes requests", async () => {
    expect(await request([review("alice", "APPROVED")])).toEqual([]);
  });

  test("a live request prevents duplicates even before its timeline event appears", async () => {
    const scope = mockState([TRANSITION], ["Alice"]);
    expect(await request([review("alice")])).toEqual([]);
    handleScope(scope);
  });

  test.each(["review_requested", "review_request_removed"])(
    "%s during this transition prevents another request when no live request remains",
    async (event) => {
      const scope = mockState([
        TRANSITION,
        { event, created_at: AFTER, requested_reviewer: { login: "alice" } },
      ]);
      expect(
        await request([review("alice"), review("alice", "COMMENTED", LATER)])
      ).toEqual([]);
      handleScope(scope);
    }
  );

  test("a request or removal from an earlier transition does not suppress a fresh re-review", async () => {
    const scopes = [
      mockState([
        TRANSITION,
        {
          event: "review_requested",
          created_at: AFTER,
          requested_reviewer: { login: "alice" },
        },
        {
          event: "review_request_removed",
          created_at: AFTER,
          requested_reviewer: { login: "alice" },
        },
        { ...TRANSITION, id: 20, created_at: LATER },
      ]),
      mockPermission("alice"),
      mockRequest(["alice"]),
    ];
    expect(await request([review("alice")])).toEqual(["alice"]);
    handleScope(scopes);
  });

  test("orders request and transition events within the same second by event ID", async () => {
    const scopes = [
      mockState([
        {
          id: 9,
          event: "review_requested",
          created_at: IN_PROGRESS,
          requested_reviewer: { login: "alice" },
        },
        TRANSITION,
      ]),
      mockPermission("alice"),
      mockRequest(["alice"]),
    ];
    expect(await request([review("alice")])).toEqual(["alice"]);
    handleScope(scopes);
  });

  test("does not notify anyone if a candidate's permission lookup fails", async () => {
    const scopes = [
      mockState(),
      mockPermission("alice"),
      api()
        .get("/repos/pytorch/pytorch/collaborators/bob/permission")
        .reply(500),
    ];
    await expect(request([review("alice"), review("bob")])).rejects.toThrow();
    handleScope(scopes);
  });

  test("does not guess the transition when timeline history is missing", async () => {
    const scope = mockState([]);
    await expect(request([review("alice")])).rejects.toThrow(
      "Cannot identify the in-progress transition"
    );
    handleScope(scope);
  });

  test("retries a failed request, then suppresses a lost-response duplicate using live requests", async () => {
    const failed = [
      mockState(),
      mockPermission("alice"),
      mockRequest(["alice"], 500),
    ];
    await expect(request([review("alice")])).rejects.toThrow();
    handleScope(failed);

    // The first failure did not create a request: the retry must deliver it.
    const retry = [
      mockState(),
      mockPermission("alice"),
      mockRequest(["alice"], 500),
    ];
    await expect(request([review("alice")])).rejects.toThrow();
    handleScope(retry);

    // This time GitHub applied the request but its response was lost. A live
    // request is sufficient even while the timeline mirror catches up.
    const recovered = mockState([TRANSITION], ["alice"]);
    expect(await request([review("alice")])).toEqual([]);
    handleScope(recovered);
  });
});
