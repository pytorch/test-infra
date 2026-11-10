import prStatusBot from "lib/bot/prStatusBot";
import {
  DRCI_COMMENT_AUTHOR,
  DRCI_COMMENT_START,
  getDrciComment,
  getPrStatusForCi,
  upsertPrStatusSection,
} from "lib/drciUtils";
import * as github from "lib/github";
import nock from "nock";
import { handleScope, requireDeepCopy } from "./common";
import { testOctokit, testProbot } from "./utils";

nock.disableNetConnect();

const REPO = "pytorch/pytorch";
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

function statusReads({ reviews = [] as object[], pr = pull() } = {}) {
  return nock("https://api.github.com")
    .get(`/repos/${REPO}/pulls/1/reviews?per_page=100`)
    .reply(200, reviews)
    .get(`/repos/${REPO}/pulls/1`)
    .reply(200, pr);
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

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(NOW);
  jest.spyOn(github, "getPrStatusOctokit").mockResolvedValue(reader);
});

afterEach(() => {
  nock.cleanAll();
  jest.restoreAllMocks();
});

test("queued status refresh reads no response APIs and leaves unchanged comments alone", async () => {
  jest
    .mocked(github.getPrStatusOctokit)
    .mockRejectedValue(new Error("Unavailable"));
  let body = "";
  let scopes = [
    statusReads(),
    commentRead(),
    commentWrite((value) => {
      body = value;
      expect(value).toContain("## PR Status: triaged");
      expect(value).toContain("queued for automated review");
      expect(value).not.toMatch(/deadline|@alice|@bob/i);
    }),
  ];
  await upsertPrStatusSection(
    writer,
    "pytorch",
    "pytorch",
    1,
    ["triaged"],
    "author"
  );
  handleScope(scopes);
  scopes = [statusReads(), commentRead(body)];
  await upsertPrStatusSection(
    writer,
    "pytorch",
    "pytorch",
    1,
    ["triaged"],
    "author"
  );
  handleScope(scopes);
  expect(github.getPrStatusOctokit).not.toHaveBeenCalled();
});

test("the triaged webhook promotes immediately and its label event refreshes Dr.CI", async () => {
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
    nock("https://api.github.com")
      .get(`/repos/${REPO}/pulls/1`)
      .reply(200, pull())
      .post(`/repos/${REPO}/issues/1/labels`, { labels: ["in progress"] })
      .reply(200, []),
  ];
  const bot = testProbot();
  bot.load(prStatusBot);
  await bot.receive({ name: "pull_request", payload, id: "test" } as any);
  handleScope(scopes);
  expect(github.getPrStatusOctokit).not.toHaveBeenCalled();
  payload.label.name = "in progress";
  const live = pull({ labels: [{ name: "triaged" }, { name: "in progress" }] });
  payload.pull_request = live;
  const refresh = [
    nock("https://api.github.com")
      .get(`/repos/${REPO}/issues/1/labels?per_page=100`)
      .reply(200, live.labels),
    statusReads({ pr: live }),
    commentRead(),
    commentWrite((value) =>
      expect(value).toContain("## PR Status: in progress")
    ),
  ];
  await bot.receive({ name: "pull_request", payload, id: "promoted" } as any);
  handleScope(refresh);
});

test("drafts pause advancement and returning to review immediately promotes", async () => {
  const bot = testProbot();
  bot.load(prStatusBot);
  const payload = requireDeepCopy("./fixtures/pull_request.labeled.json");
  payload.repository.owner.login = "pytorch";
  payload.repository.name = "pytorch";
  payload.repository.full_name = REPO;
  delete payload.label;
  payload.action = "converted_to_draft";
  Object.assign(payload.pull_request, pull({ draft: true }));
  let scopes = [
    nock("https://api.github.com")
      .get(`/repos/${REPO}/pulls/1/reviews?per_page=100`)
      .reply(200, [])
      .get(`/repos/${REPO}/pulls/1`)
      .reply(200, pull({ draft: true })),
    commentRead(),
    commentWrite((value) => {
      expect(value).toContain("## PR Status: draft");
      expect(value).not.toContain("deadline");
    }),
  ];
  await bot.receive({ name: "pull_request", payload, id: "draft" } as any);
  handleScope(scopes);
  payload.action = "ready_for_review";
  payload.pull_request.draft = false;
  scopes = [
    nock("https://api.github.com")
      .get(`/repos/${REPO}/pulls/1`)
      .reply(200, pull())
      .post(`/repos/${REPO}/issues/1/labels`, { labels: ["in progress"] })
      .reply(200, []),
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
  function liveLabels() {
    return nock("https://api.github.com")
      .get(`/repos/${REPO}/issues/1/labels?per_page=100`)
      .reply(200, [{ name: "triaged" }]);
  }

  test("the CI rebuild renders the live queued status", async () => {
    const scopes = [liveLabels(), statusReads()];
    const result = await getPrStatusForCi(reader, "pytorch", "pytorch", 1);
    expect(result?.section).toContain("## PR Status: triaged");
    expect(result?.section).toContain("queued for automated review");
    expect(result?.section).not.toMatch(/deadline/i);
    handleScope(scopes);
  });

  test.each(["labels", "reviews", "pull"])(
    "a failed %s read asks the CI rebuild to preserve its existing section",
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
        scopes.push(
          nock("https://api.github.com")
            .get(`/repos/${REPO}/pulls/1/reviews?per_page=100`)
            .reply(failure === "reviews" ? 503 : 200, [])
            .get(`/repos/${REPO}/pulls/1`)
            .reply(failure === "pull" ? 503 : 200, pull())
        );
      }
      expect(
        await getPrStatusForCi(reader, "pytorch", "pytorch", 1)
      ).toBeNull();
      handleScope(scopes);
    }
  );

  test("live removal of the last workflow label clears stale status", async () => {
    const scopes = [liveLabels(), statusReads({ pr: pull({ labels: [] }) })];
    expect(await getPrStatusForCi(reader, "pytorch", "pytorch", 1)).toEqual({
      section: "",
    });
    handleScope(scopes);
  });

  test("PRs outside the workflow need only a live label read, and other repos need none", async () => {
    const scope = nock("https://api.github.com")
      .get(`/repos/${REPO}/issues/1/labels?per_page=100`)
      .reply(200, []);
    expect(await getPrStatusForCi(reader, "pytorch", "pytorch", 1)).toEqual({
      section: "",
    });
    handleScope(scope);
    expect(await getPrStatusForCi(reader, "pytorch", "vision", 1)).toEqual({
      section: "",
    });
  });
});
