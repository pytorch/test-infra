import nock from "nock";
import { Probot } from "probot";
import myProbotApp from "../lib/bot/cancelWorkflowsOnCloseBot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";
nock.disableNetConnect();

describe("accept bot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
  });

  test("Cancel in progress workflows when not pytorchmergebot closes thr PR", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.closed.json");
    event.payload.repository.owner.login = "pytorch";
    event.payload.repository.name = "pytorch";

    const scope = nock("https://api.github.com")
      .get(
        "/repos/pytorch/pytorch/compare/main...381ace654ad6474357cedad09418340896d16d90"
      )
      .reply(200, {
        merge_base_commit: { sha: "idk something else" },
      })
      .get(
        "/repos/pytorch/pytorch/actions/runs?head_sha=381ace654ad6474357cedad09418340896d16d90&per_page=30"
      )
      .reply(200, [
        { id: 6647495490, status: "in_progress" },
        { id: 6647495495, status: "in_progress" },
        { id: 6647495497, status: "completed" },
      ])
      .post(`/repos/pytorch/pytorch/actions/runs/6647495490/cancel`)
      .reply(200, {})
      .post(`/repos/pytorch/pytorch/actions/runs/6647495495/cancel`)
      .reply(200, {});
    await probot.receive(event);

    handleScope(scope);
  });

  test("Do not cancel in progress workflows when pytorchmergebot closes the PR", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.closed.json");
    event.payload.sender.login = "pytorchmergebot";
    const scope = nock("https://api.github.com");
    await probot.receive(event);
    handleScope(scope);
  });

  test("Do not cancel in progress workflows when not pytorch/pytorch", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.closed.json");
    const scope = nock("https://api.github.com");
    await probot.receive(event);
    handleScope(scope);
  });

  test("Do not cancel in progress workflows when not pytorch/pytorch", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.closed.json");
    event.payload.repository.owner.login = "pytorch";
    event.payload.repository.name = "pytorch";
    const scope = nock("https://api.github.com")
      .get(
        "/repos/pytorch/pytorch/compare/main...381ace654ad6474357cedad09418340896d16d90"
      )
      .reply(200, {
        merge_base_commit: { sha: "381ace654ad6474357cedad09418340896d16d90" },
      });
    await probot.receive(event);
    handleScope(scope);
  });
});
