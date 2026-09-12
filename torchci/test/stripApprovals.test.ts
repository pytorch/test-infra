import nock from "nock";
import { Probot } from "probot";
import myProbotApp from "../lib/bot/stripApprovalBot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";
nock.disableNetConnect();

// The synchronize fixture is recorded on a personal repo, which the bot skips.
function synchronizeEvent() {
  const event = requireDeepCopy("./fixtures/pull_request.synchronize.json");
  event.payload.repository.owner.login = "pytorch";
  event.payload.repository.name = "pytorch";
  return event;
}

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
      .query({ per_page: 100 })
      .reply(200, review_copy)
      .put(
        `/repos/${owner}/${repo}/pulls/${pr_number}/reviews/${review_first_id}/dismissals`
      )
      .reply(200, { state: "DISMISSED" });
    await probot.receive(event);
    handleScope(scope);
  });

  test("Strip reviews when a user without write permissions pushes", async () => {
    const event = synchronizeEvent();
    const review_copy = requireDeepCopy(
      "./fixtures/pull_request_review_approved.json"
    );
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.pull_request.number;
    const login = "octocat";
    event.payload.pull_request.user.login = login;
    event.payload.sender.login = login;
    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/collaborators/${login}/permission`)
      .reply(200, { permission: "read" })
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}/reviews`)
      .query({ per_page: 100 })
      .reply(200, review_copy)
      .put(
        `/repos/${owner}/${repo}/pulls/${pr_number}/reviews/${review_copy[0].id}/dismissals`
      )
      .reply(200, { state: "DISMISSED" });
    await probot.receive(event);
    handleScope(scope);
  });

  test("Do nothing when a user with write permissions pushes", async () => {
    const event = synchronizeEvent();
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const login = "maintainer";
    event.payload.pull_request.user.login = "octocat";
    event.payload.sender.login = login;
    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/collaborators/${login}/permission`)
      .reply(200, { permission: "write" });
    await probot.receive(event);
    handleScope(scope);
  });

  // `@pytorchbot merge -r` rebases as pytorchmergebot and then merges: stripping the
  // approval here would make the merge it is running fail its own approval check.
  test("Do nothing when mergebot rebases a PR from a user without write permissions", async () => {
    const event = synchronizeEvent();
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    event.payload.pull_request.user.login = "octocat";
    event.payload.sender.login = "pytorchmergebot";
    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/collaborators/pytorchmergebot/permission`)
      .reply(200, { permission: "write" });
    await probot.receive(event);
    handleScope(scope);
  });

  test("Strip approvals that fall on a later page of reviews", async () => {
    const event = synchronizeEvent();
    const review_copy = requireDeepCopy(
      "./fixtures/pull_request_review_approved.json"
    );
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.pull_request.number;
    const login = "octocat";
    event.payload.sender.login = login;
    const reviews_url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pr_number}/reviews`;
    // GitHub returns reviews oldest first, so the approval that authorizes the merge
    // is the one most likely to be pushed off the first page.
    const first_page = Array.from({ length: 100 }, (_, i) => ({
      ...review_copy[0],
      id: 1000 + i,
      state: "COMMENTED",
    }));
    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/collaborators/${login}/permission`)
      .reply(200, { permission: "read" })
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}/reviews`)
      .query({ per_page: 100 })
      .reply(200, first_page, {
        link: `<${reviews_url}?per_page=100&page=2>; rel="next"`,
      })
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}/reviews`)
      .query({ per_page: 100, page: 2 })
      .reply(200, review_copy)
      .put(
        `/repos/${owner}/${repo}/pulls/${pr_number}/reviews/${review_copy[0].id}/dismissals`
      )
      .reply(200, { state: "DISMISSED" });
    await probot.receive(event);
    handleScope(scope);
  });

  test("Do nothing on a repo outside the supported orgs", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.synchronize.json");
    const scope = nock("https://api.github.com");
    await probot.receive(event);
    handleScope(scope);
  });
});
