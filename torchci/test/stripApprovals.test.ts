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
    const review_copy = requireDeepCopy(
      "./fixtures/pull_request_review_approved.json"
    );
    const review_first_id = review_copy[0].id;
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.pull_request.number;
    const login = "octocat";
    event.payload.pull_request.user.login = login;
    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/collaborators/${login}/permission`)
      .reply(200, { permission: "read" })
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}/reviews`)
      .reply(200, review_copy)
      .put(
        `/repos/${owner}/${repo}/pulls/${pr_number}/reviews/${review_first_id}/dismissals`
      )
      .reply(200, { state: "DISMISSED" });
    await probot.receive(event);
    handleScope(scope);
  });
});
