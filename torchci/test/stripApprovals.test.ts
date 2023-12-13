import nock from "nock";
import { Probot } from "probot";
import myProbotApp from "../lib/bot/stripApprovalBot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";
nock.disableNetConnect();

describe("strip approvals bot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
  });

  test("Do nothing on a contributor with write permissions", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.reopened.json");
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/collaborators/${event.payload.pull_request.user.login}/permission`
      )
      .reply(200, { permission: "write" });
    await probot.receive(event);

    handleScope(scope);
  });

  test("Strip reviews for user without write permissions", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.reopened.json");
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.pull_request.number;
    event.payload.pull_request.user.login = "mr_first_time_contributor";
    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/collaborators/${event.payload.pull_request.user.login}/permission`
      )
      .reply(200, {})
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}/reviews`)
      .reply(200, []);
    await probot.receive(event);
    handleScope(scope);
  });
});
