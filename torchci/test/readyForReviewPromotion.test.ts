import { hasTriageOrHigherPermissions } from "lib/bot/utils";
import * as clickhouse from "lib/clickhouse";
import { formDrciComment } from "lib/drciUtils";
import {
  activeUsersSince,
  fetchPrReviewHeadVerdicts,
  maybePromoteToReadyForReview,
  PromotionOutcome,
  PrReviewHeadVerdictRow,
  ReadyForReviewState,
  shouldPromoteToReadyForReview,
  STALE_REVIEW_NOTE,
  withStaleReviewNote,
} from "lib/prReview/readyForReviewPromotion";
import nock from "nock";
import { handleScope } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

const SHA = "abc123";
const AUTHOR = "author";
const STARTED_MS = Date.parse("2026-10-01T12:00:00Z");
const BEFORE = "2026-10-01T11:00:00Z";
const AFTER = "2026-10-01T13:00:00Z";

const REVIEW: PrReviewHeadVerdictRow = {
  pr_number: "1",
  head_sha: SHA,
  status: "succeeded",
  verdict: "ready_for_human_review",
  started_at_ms: String(STARTED_MS),
};

const READY: ReadyForReviewState = {
  labels: ["in progress"],
  prState: "open",
  draft: false,
  liveHeadSha: SHA,
  evaluatedHeadSha: SHA,
  review: REVIEW,
  ciGreen: true,
};

afterEach(() => {
  nock.cleanAll();
  jest.restoreAllMocks();
});

describe("shouldPromoteToReadyForReview", () => {
  test("promotes when every condition holds", () => {
    expect(shouldPromoteToReadyForReview(READY)).toBe(true);
  });

  test.each<[string, Partial<ReadyForReviewState>]>([
    ["not in progress", { labels: [] }],
    ["already ready", { labels: ["in progress", "ready for review"] }],
    ["opted out", { labels: ["in progress", "no automated review"] }],
    ["closed", { prState: "closed" }],
    ["draft", { draft: true }],
    ["head moved since Dr.CI ran", { liveHeadSha: "def456" }],
    ["CI not green", { ciGreen: false }],
    ["no review", { review: undefined }],
    ["review of another head", { review: { ...REVIEW, head_sha: "def456" } }],
    ["review failed", { review: { ...REVIEW, status: "model_error" } }],
    [
      "changes requested",
      { review: { ...REVIEW, verdict: "changes_requested" } },
    ],
    ["no start time", { review: { ...REVIEW, started_at_ms: "nope" } }],
  ])("does not promote when %s", (_name, override) => {
    expect(shouldPromoteToReadyForReview({ ...READY, ...override })).toBe(
      false
    );
  });
});

describe("activeUsersSince", () => {
  test("keeps humans other than the author active after the start", () => {
    expect(
      activeUsersSince(
        [
          { user: { login: "alice" }, at: AFTER },
          { user: { login: "alice" }, at: AFTER },
          { user: { login: "bob" }, at: BEFORE },
          { user: { login: AUTHOR }, at: AFTER },
          { user: { login: "pytorchmergebot" }, at: AFTER },
          { user: { login: "some-app[bot]" }, at: AFTER },
          { user: { login: "app", type: "Bot" }, at: AFTER },
          { user: { login: "carol" }, at: null },
          { user: null, at: AFTER },
        ],
        STARTED_MS,
        AUTHOR
      )
    ).toEqual(["alice"]);
  });
});

describe("hasTriageOrHigherPermissions", () => {
  const octokit = utils.testOctokit();

  function mockPermission(status: number, body: object = {}) {
    return nock("https://api.github.com")
      .get("/repos/pytorch/pytorch/collaborators/alice/permission")
      .reply(status, body);
  }

  test.each<[string, object, boolean]>([
    [
      "triage, reported as read",
      {
        permission: "read",
        user: { permissions: { pull: true, triage: true } },
      },
      true,
    ],
    ["a triage role", { permission: "read", role_name: "triage" }, true],
    ["write", { permission: "write", role_name: "write" }, true],
    [
      "read only",
      {
        permission: "read",
        role_name: "read",
        user: { permissions: { pull: true, triage: false } },
      },
      false,
    ],
  ])("%s", async (_name, body, expected) => {
    const scope = mockPermission(200, body);
    expect(
      await hasTriageOrHigherPermissions(octokit, "pytorch", "pytorch", "alice")
    ).toBe(expected);
    handleScope(scope);
  });

  test("treats an unknown user as no permission", async () => {
    const scope = mockPermission(404);
    expect(
      await hasTriageOrHigherPermissions(octokit, "pytorch", "pytorch", "alice")
    ).toBe(false);
    handleScope(scope);
  });

  test("propagates other errors", async () => {
    const scope = mockPermission(500);
    await expect(
      hasTriageOrHigherPermissions(octokit, "pytorch", "pytorch", "alice")
    ).rejects.toThrow();
    handleScope(scope);
  });
});

describe("fetchPrReviewHeadVerdicts", () => {
  test("keeps only the row for the head Dr.CI evaluated", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouseSaved")
      .mockResolvedValue([
        { ...REVIEW, head_sha: "old" },
        REVIEW,
        { ...REVIEW, pr_number: "2" },
      ]);
    const verdicts = await fetchPrReviewHeadVerdicts(
      "pytorch",
      "pytorch",
      new Map([
        [1, SHA],
        [2, "other"],
      ])
    );
    expect(query).toHaveBeenCalledWith("pr_review_head_verdicts_for_prs", {
      repo: "pytorch/pytorch",
      prNumbers: [1, 2],
    });
    expect(Array.from(verdicts.entries())).toEqual([[1, REVIEW]]);
  });

  test("issues no query for an empty sweep", async () => {
    const query = jest.spyOn(clickhouse, "queryClickhouseSaved");
    expect(
      (await fetchPrReviewHeadVerdicts("pytorch", "pytorch", new Map())).size
    ).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("maybePromoteToReadyForReview", () => {
  const octokit = utils.testOctokit();
  const api = () => nock("https://api.github.com");

  function mockPr(overrides: object = {}) {
    return utils.mockGetPR("pytorch/pytorch", 1, {
      state: "open",
      draft: false,
      user: { login: AUTHOR },
      head: { sha: SHA },
      labels: [{ name: "in progress" }],
      ...overrides,
    });
  }

  function mockActivity(
    {
      comments = [] as object[],
      reviews = [] as object[],
      reviewComments = [] as object[],
    },
    startedMs = STARTED_MS
  ) {
    const since = encodeURIComponent(new Date(startedMs).toISOString());
    return api()
      .get(
        `/repos/pytorch/pytorch/issues/1/comments?since=${since}&per_page=100`
      )
      .reply(200, comments)
      .get("/repos/pytorch/pytorch/pulls/1/reviews?per_page=100")
      .reply(200, reviews)
      .get(
        `/repos/pytorch/pytorch/pulls/1/comments?since=${since}&per_page=100`
      )
      .reply(200, reviewComments);
  }

  function mockPermission(login: string, role: string) {
    return api()
      .get(`/repos/pytorch/pytorch/collaborators/${login}/permission`)
      .reply(200, { role_name: role });
  }

  function mockPromote() {
    const add = utils.mockAddLabels(["ready for review"], "pytorch/pytorch", 1);
    // Add before remove, so the PR always has a status label
    const remove = api()
      .delete("/repos/pytorch/pytorch/issues/1/labels/in%20progress")
      .reply(() => {
        expect(add.isDone()).toBe(true);
        return [200, []];
      });
    return [add, remove];
  }

  const promote = (ciGreen = true, review = REVIEW) =>
    maybePromoteToReadyForReview(
      octokit,
      "pytorch",
      "pytorch",
      1,
      SHA,
      review,
      ciGreen
    );

  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  test("makes no API call when CI is not green or the review did not pass", async () => {
    // Any GitHub call fails the test, since net connect is disabled
    expect(await promote(false)).toBe("not_eligible");
    expect(
      await promote(true, { ...REVIEW, verdict: "changes_requested" })
    ).toBe("not_eligible");
  });

  test("promotes when only non-maintainers commented after the review started", async () => {
    const scope = [
      mockPr(),
      mockActivity({
        comments: [
          { user: { login: "alice" }, created_at: AFTER },
          { user: { login: "maint" }, created_at: BEFORE },
          { user: { login: AUTHOR }, created_at: AFTER },
        ],
        reviews: [
          {
            user: { login: "maint" },
            state: "APPROVED",
            body: "",
            submitted_at: AFTER,
          },
        ],
      }),
      mockPermission("alice", "read"),
      ...mockPromote(),
    ];
    expect(await promote()).toBe("promoted");
    handleScope(scope);
  });

  test.each<[string, object]>([
    [
      "comment",
      { comments: [{ user: { login: "maint" }, created_at: AFTER }] },
    ],
    [
      "review",
      {
        reviews: [
          {
            user: { login: "maint" },
            state: "COMMENTED",
            body: "",
            submitted_at: AFTER,
          },
        ],
      },
    ],
    [
      "review comment",
      { reviewComments: [{ user: { login: "maint" }, created_at: AFTER }] },
    ],
  ])("does not promote after a maintainer %s", async (_name, activity) => {
    const scope = [
      mockPr(),
      mockActivity(activity),
      mockPermission("maint", "triage"),
    ];
    expect(await promote()).toBe("maintainer_activity");
    handleScope(scope);
  });

  test("requires a fresh passing review after a maintainer requests changes", async () => {
    const activity = {
      reviews: [
        {
          user: { login: "maint" },
          state: "CHANGES_REQUESTED",
          body: "Please add tests.",
          submitted_at: AFTER,
        },
      ],
    };
    const staleScope = [
      mockPr(),
      mockActivity(activity),
      mockPermission("maint", "write"),
    ];

    // The old passing verdict cannot immediately undo the move to in progress.
    // No label writes are mocked, so any attempted promotion fails this test.
    expect(await promote()).toBe("maintainer_activity");
    handleScope(staleScope);

    const freshStartedMs = Date.parse("2026-10-01T14:00:00Z");
    const freshScope = [
      mockPr(),
      mockActivity(activity, freshStartedMs),
      ...mockPromote(),
    ];

    // The fresh review verifies the request was addressed. Its passing verdict
    // can promote the PR without requiring the maintainer to dismiss the review.
    expect(
      await promote(true, {
        ...REVIEW,
        started_at_ms: String(freshStartedMs),
      })
    ).toBe("promoted");
    handleScope(freshScope);
  });

  test("checks live labels and head, not the evaluated ones", async () => {
    const scope = mockPr({ head: { sha: "def456" } });
    expect(await promote()).toBe("not_eligible");
    handleScope(scope);
  });

  test("fails closed when a permission lookup errors", async () => {
    const scope = [
      mockPr(),
      mockActivity({
        comments: [{ user: { login: "alice" }, created_at: AFTER }],
      }),
      api()
        .get("/repos/pytorch/pytorch/collaborators/alice/permission")
        .reply(500),
    ];
    await expect(promote()).rejects.toThrow();
    handleScope(scope);
  });
});

describe("withStaleReviewNote", () => {
  const SECTION =
    "\n<details><summary>review</summary><p>\n\nbody\n\n</p></details>";
  const render = (outcome: PromotionOutcome) =>
    formDrciComment(
      1,
      "pytorch",
      "pytorch",
      "",
      "",
      "",
      "",
      [],
      withStaleReviewNote(SECTION, outcome)
    );

  test("shows the note, outside the collapsed section, only after maintainer activity", () => {
    expect(render("maintainer_activity")).toContain(
      `</p></details>\n\n${STALE_REVIEW_NOTE}\n`
    );
    expect(render("promoted")).not.toContain(STALE_REVIEW_NOTE);
    expect(render("not_eligible")).not.toContain(STALE_REVIEW_NOTE);
  });
});
