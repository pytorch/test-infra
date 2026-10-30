import prStatusBot from "lib/bot/prStatusBot";
import {
  markInProgressIfAccepted,
  updateInProgressLabels,
} from "lib/bot/preReviewSweep";
import pytorchBot from "lib/bot/pytorchBot";
import {
  DRCI_COMMENT_AUTHOR,
  DRCI_COMMENT_START,
  getDrciComment,
  getPrStatusForCi,
  upsertPrStatusSection,
} from "lib/drciUtils";
import * as github from "lib/github";
import { PR_STATUS_END, PR_STATUS_START } from "lib/prStatus";
import nock from "nock";
import { handleScope, requireDeepCopy } from "./common";
import { testOctokit, testProbot } from "./utils";

nock.disableNetConnect();

const REPO = "pytorch/pytorch";
const ENTERED = "2026-10-29T16:30:00Z";
const DEADLINE = "2026-11-05T16:30:00.000Z";
const NOW = Date.parse("2026-10-30T16:30:00Z");
const REST = "\n## Helpful Links\nlinks\n## CI results\nexisting results\n";
const INITIAL_COMMENT = DRCI_COMMENT_START + REST;
const reader = testOctokit();
const writer = testOctokit();

function pull(overrides = {}) {
  return {
    number: 1,
    state: "open",
    draft: false,
    created_at: "2026-10-01T00:00:00Z",
    labels: [{ name: "triaged" }],
    user: { login: "author" },
    requested_reviewers: [{ login: "alice" }, { login: "bob" }],
    requested_teams: [],
    ...overrides,
  };
}

function reaction(login: string, content = "+1") {
  return { content, user: { login } };
}

function statusReads({ reviews = [] as object[], pr = pull() } = {}) {
  return nock("https://api.github.com")
    .get(`/repos/${REPO}/pulls/1/reviews?per_page=100`)
    .reply(200, reviews)
    .get(`/repos/${REPO}/pulls/1`)
    .reply(200, pr);
}

function policyReads({
  reactions = [reaction("alice")],
  events = [] as object[],
  reviews = [] as object[],
  pr = pull(),
} = {}) {
  return statusReads({ reviews, pr })
    .get(`/repos/${REPO}/issues/1/timeline?per_page=100`)
    .reply(200, [
      { event: "labeled", label: { name: "triaged" }, created_at: ENTERED },
      ...events,
    ])
    .get(`/repos/${REPO}/issues/1/reactions?per_page=100`)
    .reply(200, reactions);
}

function commentRead(body = INITIAL_COMMENT) {
  return nock("https://api.github.com")
    .get(`/repos/${REPO}/issues/1/comments`)
    .reply(200, [{ id: 10, user: { login: DRCI_COMMENT_AUTHOR }, body }]);
}

function commentWrite(check: (_body: string) => void) {
  return nock("https://api.github.com")
    .patch(`/repos/${REPO}/issues/comments/10`, (body) => {
      expect(body.body).toContain(REST);
      expect(body.body.match(/## PR Status:/g)).toHaveLength(1);
      check(body.body);
      return true;
    })
    .reply(200, {});
}

function search() {
  return nock("https://api.github.com")
    .get("/search/issues")
    .query(true)
    .reply(200, {
      total_count: 1,
      items: [{ ...pull(), updated_at: ENTERED }],
    });
}

async function checkPreReview() {
  return markInProgressIfAccepted(
    reader,
    writer,
    "pytorch",
    "pytorch",
    1,
    ["triaged"],
    "author"
  );
}

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(NOW);
  jest.spyOn(github, "getPreReviewOctokit").mockResolvedValue(reader);
});

afterEach(() => {
  nock.cleanAll();
  jest.restoreAllMocks();
});

test("the periodic check reports reaction progress without CI or webhooks and doesn't rewrite unchanged comments", async () => {
  const writerReads = jest.spyOn(writer, "paginate");
  const writerPullReads = jest.spyOn(writer.rest.pulls, "get");
  const readerWrites = jest.spyOn(reader.rest.issues, "updateComment");
  let body = "";
  let scopes = [
    search(),
    policyReads(),
    commentRead(),
    commentWrite((value) => {
      body = value;
      expect(value).toContain("**Waiting for pre-review:** `bob`.");
      expect(value).toContain("**Pre-review accepted:** `alice`.");
      expect(value).toContain("2026-11-05 16:30:00 UTC");
      expect(value).not.toMatch(/@(alice|bob)/);
    }),
  ];
  expect(
    (await updateInProgressLabels(reader, writer, "pytorch", "pytorch")).failed
  ).toEqual([]);
  handleScope(scopes);

  scopes = [search(), policyReads(), commentRead(body)];
  expect(
    (await updateInProgressLabels(reader, writer, "pytorch", "pytorch")).failed
  ).toEqual([]);
  handleScope(scopes); // No PATCH was mocked: identical progress is a no-op.

  scopes = [
    search(),
    policyReads({ reactions: [] }),
    commentRead(body),
    commentWrite((value) => {
      expect(value).toContain("**Waiting for pre-review:** `alice`, `bob`.");
      expect(value).not.toContain("**Pre-review accepted:");
    }),
  ];
  expect(
    (await updateInProgressLabels(reader, writer, "pytorch", "pytorch")).failed
  ).toEqual([]);
  handleScope(scopes);
  expect(writerReads).not.toHaveBeenCalled();
  expect(writerPullReads).not.toHaveBeenCalled();
  expect(readerWrites).not.toHaveBeenCalled();
});

test("fourteen silent reviewers expire together and the status advances even without the label webhook", async () => {
  jest.spyOn(Date, "now").mockReturnValue(Date.parse(DEADLINE));
  const pr = pull({
    requested_reviewers: Array.from({ length: 14 }, (_, i) => ({
      login: `reviewer-${i}`,
    })),
  });
  const scopes = [
    search(),
    policyReads({ pr, reactions: [] }),
    nock("https://api.github.com")
      .get(`/repos/${REPO}/pulls/1`)
      .reply(200, pr)
      .post(`/repos/${REPO}/issues/1/labels`, { labels: ["in progress"] })
      .reply(200, []),
    commentRead(),
    commentWrite((value) => {
      expect(value).toContain("## PR Status: in progress");
      expect(value).not.toContain("Waiting for pre-review");
    }),
  ];
  expect(
    (await updateInProgressLabels(reader, writer, "pytorch", "pytorch")).failed
  ).toEqual([]);
  handleScope(scopes);
});

test("after expiry only the explicit team objection is shown, without crediting silent reviewers", async () => {
  jest.spyOn(Date, "now").mockReturnValue(Date.parse(DEADLINE));
  const scopes = [
    policyReads({
      pr: pull({ requested_teams: [{ slug: "core" }] }),
      reactions: [reaction("carol", "-1")],
    }),
    nock("https://api.github.com")
      .get("/orgs/pytorch/teams/core/members?per_page=100")
      .reply(200, [{ login: "carol" }]),
    commentRead(),
    commentWrite((value) => {
      expect(value).toContain(
        "**Pre-review request changes:** `pytorch/core`."
      );
      expect(value).not.toContain("`alice`");
      expect(value).not.toContain("`bob`");
      expect(value).not.toContain("**Pre-review accepted:");
      expect(value).toContain("This deadline has passed");
    }),
  ];
  expect((await checkPreReview()).accepted).toBe(false);
  handleScope(scopes);
});

test("the triaged label webhook immediately publishes pre-review status", async () => {
  const payload = requireDeepCopy("./fixtures/pull_request.labeled.json");
  payload.repository.owner.login = "pytorch";
  payload.repository.name = "pytorch";
  payload.repository.full_name = REPO;
  Object.assign(payload.pull_request, pull());
  payload.action = "labeled";
  payload.label.name = "triaged";
  const scopes = [
    nock("https://api.github.com")
      .get(`/repos/${REPO}/issues/1/labels?per_page=100`)
      .reply(200, [{ name: "triaged" }]),
    policyReads(),
    commentRead(),
    commentWrite((value) =>
      expect(value).toContain("**Waiting for pre-review:** `bob`.")
    ),
  ];
  const bot = testProbot();
  bot.load(prStatusBot);
  await bot.receive({ name: "pull_request", payload, id: "test" } as any);
  handleScope(scopes);
});

test("the accept command updates progress before its comment reaches the timeline", async () => {
  const event = requireDeepCopy("./fixtures/pull_request_comment.json");
  event.payload.repository.owner.login = "pytorch";
  event.payload.repository.name = "pytorch";
  event.payload.repository.full_name = REPO;
  Object.assign(event.payload.issue, pull());
  event.payload.comment.user.login = "alice";
  event.payload.comment.body = "@pytorchbot pre-review accept";
  const scopes = [
    policyReads({ reactions: [] }),
    commentRead(),
    commentWrite((value) => {
      expect(value).toContain("**Pre-review accepted:** `alice`.");
      expect(value).toContain("**Waiting for pre-review:** `bob`.");
    }),
    nock("https://api.github.com")
      .post(
        `/repos/${REPO}/issues/comments/${event.payload.comment.id}/reactions`,
        { content: "+1" }
      )
      .reply(200, {}),
  ];
  const bot = testProbot();
  bot.load(pytorchBot);
  await bot.receive(event);
  handleScope(scopes);
});

test("draft transitions replace an obsolete deadline and returning to review displays the reset deadline", async () => {
  const bot = testProbot();
  bot.load(prStatusBot);
  const payload = requireDeepCopy("./fixtures/pull_request.labeled.json");
  payload.repository.owner.login = "pytorch";
  payload.repository.name = "pytorch";
  payload.repository.full_name = REPO;
  delete payload.label;
  payload.action = "converted_to_draft";
  Object.assign(payload.pull_request, pull({ draft: true }));
  let body = "";
  let scopes = [
    nock("https://api.github.com")
      .get(`/repos/${REPO}/pulls/1/reviews?per_page=100`)
      .reply(200, [])
      .get(`/repos/${REPO}/pulls/1`)
      .reply(200, pull({ draft: true })),
    commentRead(),
    commentWrite((value) => {
      body = value;
      expect(value).toContain("## PR Status: draft");
      expect(value).not.toContain("Pre-review deadline");
    }),
  ];
  await bot.receive({ name: "pull_request", payload, id: "draft" } as any);
  handleScope(scopes);
  payload.action = "ready_for_review";
  payload.pull_request.draft = false;
  scopes = [
    policyReads({
      events: [
        { event: "ready_for_review", created_at: new Date(NOW).toISOString() },
      ],
    }),
    commentRead(body),
    commentWrite((value) => expect(value).toContain("2026-11-06 16:30:00 UTC")),
  ];
  await bot.receive({ name: "pull_request", payload, id: "ready" } as any);
  handleScope(scopes);
});

test("finds the bot's comment after the first page, ignoring copied markers and stopping once found", async () => {
  const scopes = [
    nock("https://api.github.com")
      .get(`/repos/${REPO}/issues/1/comments`)
      .reply(
        200,
        [{ id: 9, user: { login: "someone-else" }, body: INITIAL_COMMENT }],
        {
          link: `<https://api.github.com/repos/${REPO}/issues/1/comments?page=2>; rel="next"`,
        }
      )
      .get(`/repos/${REPO}/issues/1/comments?page=2`)
      .reply(
        200,
        [
          {
            id: 10,
            user: { login: DRCI_COMMENT_AUTHOR },
            body: INITIAL_COMMENT,
          },
        ],
        {
          link: `<https://api.github.com/repos/${REPO}/issues/1/comments?page=3>; rel="next"`,
        }
      ),
  ];
  expect(await getDrciComment(reader, "pytorch", "pytorch", 1)).toEqual({
    id: 10,
    body: INITIAL_COMMENT,
  });
  handleScope(scopes);
});

test("pre-review status refresh reads reactions through the dedicated app", async () => {
  const scopes = [
    policyReads(),
    commentRead(),
    commentWrite((value) => {
      expect(value).toContain("**Pre-review accepted:** `alice`.");
    }),
  ];
  const writerReads = jest.spyOn(writer, "paginate");
  await upsertPrStatusSection(
    writer,
    "pytorch",
    "pytorch",
    1,
    ["triaged"],
    "author"
  );
  expect(writerReads).not.toHaveBeenCalled();
  handleScope(scopes);
});

test.each(["in progress", "ready for review", "missing actionable issue"])(
  "draft status works with only the %s label and survives a failed metadata read",
  async (label) => {
    const labels = [label];
    const bot = testProbot();
    bot.load(prStatusBot);
    const payload = requireDeepCopy("./fixtures/pull_request.labeled.json");
    payload.repository.owner.login = "pytorch";
    payload.repository.name = "pytorch";
    payload.repository.full_name = REPO;
    delete payload.label;
    payload.action = "converted_to_draft";
    Object.assign(
      payload.pull_request,
      pull({ draft: true, labels: [{ name: label }] })
    );
    const scopes = [
      statusReads({ pr: payload.pull_request }),
      commentRead(),
      commentWrite((value) => expect(value).toContain("## PR Status: draft")),
    ];
    await bot.receive({ name: "pull_request", payload, id: "draft" } as any);
    handleScope(scopes);

    const failed = nock("https://api.github.com")
      .get(`/repos/${REPO}/pulls/1/reviews?per_page=100`)
      .reply(200, [])
      .get(`/repos/${REPO}/pulls/1`)
      .reply(503);
    // No comment reads or writes: unknown draft state must not overwrite the
    // successfully published draft with a phase inferred from the label.
    await upsertPrStatusSection(
      writer,
      "pytorch",
      "pytorch",
      1,
      labels,
      "author"
    );
    handleScope(failed);
  }
);

describe("status preservation during CI rebuilds", () => {
  const section = (waiting: string) =>
    `${PR_STATUS_START}\n## PR Status: in pre-review\n\nWaiting: ${waiting}\n${PR_STATUS_END}\n`;
  const currentBody = DRCI_COMMENT_START + section("bob") + REST;

  function liveLabels() {
    return nock("https://api.github.com")
      .get(`/repos/${REPO}/issues/1/labels?per_page=100`)
      .reply(200, [{ name: "triaged" }]);
  }

  test("discovers live workflow labels and preserves progress without needing a mirror or polling reactions", async () => {
    const scopes = [liveLabels(), statusReads(), commentRead(currentBody)];
    expect(await getPrStatusForCi(writer, "pytorch", "pytorch", 1)).toEqual({
      section: section("bob"),
      comment: { id: 10, body: currentBody },
    });
    handleScope(scopes);
  });

  test.each(["labels", "reviews", "pull", "comment"])(
    "a failed %s read skips the CI write instead of returning a stale section",
    async (failure) => {
      jest.spyOn(console, "error").mockImplementation(() => {});
      jest.spyOn(console, "warn").mockImplementation(() => {});
      const scopes = [];
      if (failure === "labels") {
        scopes.push(
          nock("https://api.github.com")
            .get(`/repos/${REPO}/issues/1/labels?per_page=100`)
            .reply(503)
        );
      } else {
        scopes.push(liveLabels());
        if (failure === "comment") {
          scopes.push(
            statusReads(),
            nock("https://api.github.com")
              .get(`/repos/${REPO}/issues/1/comments`)
              .reply(503)
          );
        } else {
          scopes.push(
            nock("https://api.github.com")
              .get(`/repos/${REPO}/pulls/1/reviews?per_page=100`)
              .reply(failure === "reviews" ? 503 : 200, [])
              .get(`/repos/${REPO}/pulls/1`)
              .reply(failure === "pull" ? 503 : 200, pull())
          );
        }
      }
      expect(
        await getPrStatusForCi(writer, "pytorch", "pytorch", 1)
      ).toBeNull();
      handleScope(scopes);
    }
  );

  test("live removal of the last workflow label clears stale status", async () => {
    const scopes = [liveLabels(), statusReads({ pr: pull({ labels: [] }) })];
    expect(await getPrStatusForCi(writer, "pytorch", "pytorch", 1)).toEqual({
      section: "",
    });
    handleScope(scopes);
  });

  test("PRs outside the workflow need only a live label read, and other repos need none", async () => {
    const scope = nock("https://api.github.com")
      .get(`/repos/${REPO}/issues/1/labels?per_page=100`)
      .reply(200, []);
    expect(await getPrStatusForCi(writer, "pytorch", "pytorch", 1)).toEqual({
      section: "",
    });
    handleScope(scope);
    expect(await getPrStatusForCi(writer, "pytorch", "vision", 1)).toEqual({
      section: "",
    });
  });
});
