import nock from "nock";
import { Probot } from "probot";
import triggerInductorTestsBot from "../lib/bot/triggerInductorTestsBot";
import { requireDeepCopy } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

describe("trigger-inductor-tests-bot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(triggerInductorTestsBot);
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("triggers inductor tests for preapproved user and repo", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "trigger inductor tests";
    event.payload.comment.user.login = "pytorchbot";
    event.payload.repository.owner.login = "malfet";
    event.payload.repository.name = "deleteme";

    const scope = nock("https://api.github.com")
      .post("/repos/malfet/deleteme/issues/31/comments", (body) => {
        expect(body.body).toBe("Inductor tests triggered");
        return true;
      })
      .reply(200);

    await probot.receive(event);

    scope.done();
  });

  test("does not trigger for non-preapproved user", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "trigger inductor tests";
    event.payload.comment.user.login = "nonApprovedUser";
    event.payload.repository.owner.login = "malfet";
    event.payload.repository.name = "deleteme";

    const scope = nock("https://api.github.com");

    await probot.receive(event);

    scope.done();
  });

  test("does not trigger for non-preapproved repo", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "trigger inductor tests";
    event.payload.comment.user.login = "pytorchbot";
    event.payload.repository.owner.login = "fakeorg";
    event.payload.repository.name = "fakerepo";

    const scope = nock("https://api.github.com");

    await probot.receive(event);

    scope.done();
  });

  test("does not trigger for irrelevant comment", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "random comment";
    event.payload.comment.user.login = "pytorchbot";
    event.payload.repository.owner.login = "malfet";
    event.payload.repository.name = "deleteme";

    const scope = nock("https://api.github.com");

    await probot.receive(event);

    scope.done();
  });
});
