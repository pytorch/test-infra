import pytorchBot from "lib/bot/pytorchBot";
import nock from "nock";
import * as probot from "probot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

const AUTHOR = "author";
const MISSING_ISSUE_LABELS = [
  "open source",
  "triaged",
  "bot-triaged",
  "missing actionable issue",
];

describe("triage command", () => {
  let bot: probot.Probot;

  beforeEach(() => {
    bot = utils.testProbot();
    bot.load(pytorchBot);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  function triageEvent(
    commenter: string,
    labels: string[] = MISSING_ISSUE_LABELS,
    repo: string = "pytorch"
  ) {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "@pytorchbot triage";
    event.payload.comment.user.login = commenter;
    event.payload.issue.number = 1;
    event.payload.issue.user.login = AUTHOR;
    event.payload.issue.labels = labels.map((name) => ({ name }));
    event.payload.repository.owner.login = "pytorch";
    event.payload.repository.name = repo;
    event.payload.repository.full_name = `pytorch/${repo}`;
    return event;
  }

  function mockReact(event: any, content: "+1" | "-1") {
    const repo = event.payload.repository.full_name;
    return nock("https://api.github.com")
      .post(
        `/repos/${repo}/issues/comments/${event.payload.comment.id}/reactions`,
        (body) => {
          expect(body.content).toBe(content);
          return true;
        }
      )
      .reply(200, {});
  }

  function mockReply(event: any, contains: string) {
    const repo = event.payload.repository.full_name;
    return nock("https://api.github.com")
      .post(`/repos/${repo}/issues/1/comments`, (body) => {
        expect(body.body).toContain(contains);
        return true;
      })
      .reply(200, {});
  }

  function mockLiveLabels(labels: string[]) {
    return nock("https://api.github.com")
      .get("/repos/pytorch/pytorch/issues/1/labels?per_page=100")
      .reply(
        200,
        labels.map((name) => ({ name }))
      );
  }

  function mockTriage(
    labelsToRemove: string[],
    { alreadyRemoved = [] as string[] } = {}
  ) {
    const removes = labelsToRemove.map((label) =>
      nock("https://api.github.com")
        .delete(
          `/repos/pytorch/pytorch/issues/1/labels/${encodeURIComponent(label)}`
        )
        .reply(alreadyRemoved.includes(label) ? 404 : 200, [])
    );
    const add = nock("https://api.github.com")
      .post("/repos/pytorch/pytorch/issues/1/labels", (body) => {
        // The outcome labels must be gone before the run starts, and
        // `open source` removed first so this is a fresh `labeled` event
        expect(removes.every((remove) => remove.isDone())).toBe(true);
        expect(body).toMatchObject({ labels: ["open source"] });
        return true;
      })
      .reply(200, {});
    return [...removes, add];
  }

  test("the author re-runs triage by cycling the triage labels", async () => {
    const event = triageEvent(AUTHOR);
    const scope = [
      mockLiveLabels(MISSING_ISSUE_LABELS),
      ...mockTriage([
        "triaged",
        "bot-triaged",
        "missing actionable issue",
        "open source",
      ]),
      mockReact(event, "+1"),
    ];

    await bot.receive(event);
    handleScope(scope);
  });

  test("anyone may re-run triage", async () => {
    const event = triageEvent("stranger");
    const scope = [
      mockLiveLabels(MISSING_ISSUE_LABELS),
      ...mockTriage([
        "triaged",
        "bot-triaged",
        "missing actionable issue",
        "open source",
      ]),
      mockReact(event, "+1"),
    ];

    await bot.receive(event);
    handleScope(scope);
  });

  test("only removes labels the PR carries, read live", async () => {
    // The webhook snapshot is stale: triaged and bot-triaged are gone
    const event = triageEvent(AUTHOR);
    const scope = [
      mockLiveLabels([
        "open source",
        "missing actionable issue",
        "bot-triage-error",
      ]),
      ...mockTriage([
        "missing actionable issue",
        "bot-triage-error",
        "open source",
      ]),
      mockReact(event, "+1"),
    ];

    await bot.receive(event);
    handleScope(scope);
  });

  test("a label removed concurrently does not stop the rerun", async () => {
    const event = triageEvent(AUTHOR);
    const scope = [
      mockLiveLabels(MISSING_ISSUE_LABELS),
      ...mockTriage(
        ["triaged", "bot-triaged", "missing actionable issue", "open source"],
        { alreadyRemoved: ["bot-triaged"] }
      ),
      mockReact(event, "+1"),
    ];

    await bot.receive(event);
    handleScope(scope);
  });

  test.each([
    [
      ["open source", "triaged", "bot-triaged"],
      ["triaged", "bot-triaged", "open source"],
    ],
    [
      ["open source", "bot-triage-error"],
      ["bot-triage-error", "open source"],
    ],
    [["open source"], ["open source"]],
  ])("re-runs triage on a PR labeled %j", async (labels, labelsToRemove) => {
    const event = triageEvent(AUTHOR, labels);
    const scope = [
      mockLiveLabels(labels),
      ...mockTriage(labelsToRemove),
      mockReact(event, "+1"),
    ];

    await bot.receive(event);
    handleScope(scope);
  });

  test.each([[[]], [["triaged", "bot-triaged", "missing actionable issue"]]])(
    "rejects a PR without open source, labeled %j",
    async (labels) => {
      const event = triageEvent(AUTHOR, labels);
      const scope = [
        mockLiveLabels(labels),
        mockReact(event, "-1"),
        mockReply(event, "only re-runs on PRs labeled `open source`"),
      ];

      await bot.receive(event);
      handleScope(scope);
    }
  );

  test("rejects an opted-out PR without changing labels", async () => {
    const labels = [...MISSING_ISSUE_LABELS, "no automated triage"];
    const event = triageEvent(AUTHOR, labels);
    const scope = [
      mockLiveLabels(labels),
      mockReact(event, "-1"),
      mockReply(event, "skips PRs labeled `no automated triage`"),
    ];

    await bot.receive(event);
    handleScope(scope);
  });

  test("rejects outside pytorch/pytorch", async () => {
    const event = triageEvent(AUTHOR, MISSING_ISSUE_LABELS, "vision");
    const scope = [
      mockReact(event, "-1"),
      mockReply(event, "only runs on pytorch/pytorch"),
    ];

    await bot.receive(event);
    handleScope(scope);
  });
});
