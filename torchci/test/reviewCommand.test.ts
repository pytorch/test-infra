import pytorchBot from "lib/bot/pytorchBot";
import nock from "nock";
import * as probot from "probot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

const AUTHOR = "author";

describe("review command", () => {
  let bot: probot.Probot;

  beforeEach(() => {
    bot = utils.testProbot();
    bot.load(pytorchBot);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  function reviewEvent(
    commenter: string,
    labels: string[] = ["in progress"],
    repo: string = "pytorch"
  ) {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "@pytorchbot review";
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

  function mockCycleLabel() {
    const remove = nock("https://api.github.com")
      .delete("/repos/pytorch/pytorch/issues/1/labels/in%20progress")
      .reply(200, []);
    const add = nock("https://api.github.com")
      .post("/repos/pytorch/pytorch/issues/1/labels", (body) => {
        // Remove before add, so the label event is a fresh `labeled`
        expect(remove.isDone()).toBe(true);
        expect(body).toMatchObject({ labels: ["in progress"] });
        return true;
      })
      .reply(200, {});
    return [remove, add];
  }

  test("the author re-runs the review by cycling in progress", async () => {
    const event = reviewEvent(AUTHOR);
    const scope = [...mockCycleLabel(), mockReact(event, "+1")];

    await bot.receive(event);
    handleScope(scope);
  });

  test("anyone may re-run the review", async () => {
    const event = reviewEvent("stranger");
    const scope = [...mockCycleLabel(), mockReact(event, "+1")];

    await bot.receive(event);
    handleScope(scope);
  });

  test.each([
    [[]],
    [["in progress", "ready for review"]],
    [["in progress", "no automated review"]],
  ])("rejects a PR labeled %j", async (labels) => {
    const event = reviewEvent(AUTHOR, labels);
    const scope = [
      mockReact(event, "-1"),
      mockReply(event, "only re-runs on PRs labeled `in progress`"),
    ];

    await bot.receive(event);
    handleScope(scope);
  });

  test("rejects outside pytorch/pytorch", async () => {
    const event = reviewEvent(AUTHOR, ["in progress"], "vision");
    const scope = [
      mockReact(event, "-1"),
      mockReply(event, "only runs on pytorch/pytorch"),
    ];

    await bot.receive(event);
    handleScope(scope);
  });
});
