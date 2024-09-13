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
      .post(
        "/repos/pytorch/pytorch-integration-testing/actions/workflows/triton-inductor.yml/dispatches",
        (body) => {
          expect(JSON.stringify(body)).toContain(
            `{"ref":"main","inputs\":{"triton_commit":"main","pytorch_commit":"viable/strict"}}`
          );
          return true;
        }
      )
      .reply(200, {})
      .post("/repos/malfet/deleteme/issues/31/comments", (body) => {
        expect(body.body).toBe("Inductor tests triggered successfully");
        return true;
      })
      .reply(200);

    await probot.receive(event);

    scope.done();
  });

  test("triggers inductor tests for triton repo", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "trigger inductor tests";
    event.payload.comment.user.login = "pytorchbot";
    event.payload.repository.owner.login = "triton-lang-test";
    event.payload.repository.name = "triton";

    const scope = nock("https://api.github.com")
      .get("/repos/triton-lang-test/triton/pulls/31")
      .reply(200, {
        head: {
          sha: "custom_triton_sha",
        },
      })
      .post(
        "/repos/pytorch/pytorch-integration-testing/actions/workflows/triton-inductor.yml/dispatches",
        (body) => {
          expect(JSON.stringify(body)).toContain(
            `{"ref":"main","inputs\":{"triton_commit":"custom_triton_sha","pytorch_commit":"viable/strict"}}`
          );
          return true;
        }
      )
      .reply(200, {})
      .post("/repos/triton-lang-test/triton/issues/31/comments", (body) => {
        expect(body.body).toBe("Inductor tests triggered successfully");
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
