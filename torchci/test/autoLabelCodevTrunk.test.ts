import * as botUtils from "lib/bot/utils";
import nock from "nock";
import { Probot } from "probot";
import myProbotApp from "../lib/bot/autoLabelCodevTrunk";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";

nock.disableNetConnect();

describe("autoLabelCodevTrunkBot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
    const mock = jest.spyOn(botUtils, "isPyTorchPyTorch");
    mock.mockReturnValue(true);
    // zhouzhuojie/gha-ci-playground is the repo used in almost all the tests
    utils.mockHasApprovedWorkflowRun("zhouzhuojie/gha-ci-playground");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nock.cleanAll();
  });
  test("Review adds ciflow/trunk label for codev pr", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_review.json");
    event.payload.review.state = "approved";
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.pull_request.number;
    event.payload.pull_request.body = "Differential Revision: D12345678";
    utils.mockHasApprovedWorkflowRun(`${owner}/${repo}`);

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/labels`, (body) => {
        expect(JSON.stringify(body)).toContain(`"ciflow/trunk"`);
        return true;
      })
      .reply(200, {});
    await probot.receive(event);

    scope.done();
  });
  test("Review does not add ciflow/trunk label if it is not approving", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_review.json");
    event.payload.review.state = "CHANGES_REQUESTED";
    event.payload.pull_request.body = "Differential Revision: D12345678";

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const scope = nock("https://api.github.com");
    await probot.receive(event);

    scope.done();
  });

  test("Review does not add ciflow/trunk label for non-codev pr", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_review.json");
    event.payload.review.state = "approved";
    event.payload.pull_request.body = "Definitely not a codev pr";

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const scope = nock("https://api.github.com");
    await probot.receive(event);

    scope.done();
  });

  test("Review does not add ciflow/trunk label for codev pr without write permissions", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_review.json");
    event.payload.review.state = "approved";
    event.payload.repository.owner.login = "random";
    event.payload.repository.name = "random";
    event.payload.pull_request.body = "Differential Revision: D12345678";
    const pr_number = event.payload.pull_request.number;
    const author = event.payload.pull_request.user.login;
    const repoFullName = `${event.payload.repository.owner.login}/${event.payload.repository.name}`;
    const headSha = event.payload.pull_request.head.sha;

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const scope = [
      utils.mockPermissions(repoFullName, author, "read"),
      utils.mockApprovedWorkflowRuns(repoFullName, headSha, false),
    ];
    await probot.receive(event);

    handleScope(scope);
  });

  test("Imported PR adds ciflow/trunk label", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.edited.json");
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.pull_request.number;
    event.payload.pull_request.body = "Differential Revision: D12345678";
    event.payload.changes.body.from = "";
    utils.mockHasApprovedWorkflowRun(`${owner}/${repo}`);

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/labels`, (body) => {
        expect(JSON.stringify(body)).toContain(`"ciflow/trunk"`);
        return true;
      })
      .reply(200, {});
    await probot.receive(event);

    scope.done();
  });

  test("Imported PR does not add ciflow/trunk label if no write permissions", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.edited.json");
    const pr_number = event.payload.pull_request.number;
    event.payload.pull_request.body = "Differential Revision: D12345678";
    event.payload.changes.body.from = "";
    const author = event.payload.pull_request.user.login;
    const repoFullName = `${event.payload.repository.owner.login}/${event.payload.repository.name}`;
    const headSha = event.payload.pull_request.head.sha;

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const scope = [
      utils.mockPermissions(repoFullName, author, "read"),
      utils.mockApprovedWorkflowRuns(repoFullName, headSha, false),
    ];
    await probot.receive(event);

    handleScope(scope);
  });

  test("Imported PR does not add ciflow/trunk if it was previously imported", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.edited.json");
    event.payload.pull_request.body = "Differential Revision: D12345678";
    event.payload.changes.body.from = "Differential Revision: D12345678";

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const scope = nock("https://api.github.com");
    await probot.receive(event);

    scope.done();
  });

  test("PR does not add ciflow/trunk if it was not imported", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.edited.json");
    event.payload.pull_request.body = "random";
    event.payload.changes.body.from = "Differential Revision: D12345678";

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const scope = nock("https://api.github.com");
    await probot.receive(event);

    scope.done();
  });

  test("PR does not add ciflow/trunk on random comment (wrong content)", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.body = "random";
    event.payload.comment.user.login = "facebook-github-bot";

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const scope = nock("https://api.github.com");
    await probot.receive(event);

    scope.done();
  });

  test("PR does not add ciflow/trunk on random comment (wrong user)", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body =
      "@clee2000 has imported this pull request. If you are a Meta employee, you can view this diff [on Phabricator](https://www.internalfb.com/diff/D64475068).";
    event.payload.comment.user.login = "random user";

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const scope = nock("https://api.github.com");
    await probot.receive(event);

    scope.done();
  });

  test("PR does not add ciflow/trunk on comment (no permissions)", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body =
      "@clee2000 has imported this pull request. If you are a Meta employee, you can view this diff [on Phabricator](https://www.internalfb.com/diff/D64475068).";
    event.payload.comment.user.login = "facebook-github-bot";
    const owner = "clee2000";
    const repo = "random-testing";
    event.payload.repository.owner.login = owner;
    event.payload.repository.name = repo;
    const repoFullName = `${owner}/${repo}`;
    const author = event.payload.issue.user.login;
    const headSha = "random";

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const scope = [
      utils.mockGetPR(repoFullName, event.payload.issue.number, {
        user: { login: author },
        head: { sha: headSha },
        base: { repo: { name: repo, owner: { login: owner } } },
      }),
      utils.mockPermissions(repoFullName, author, "read"),
      utils.mockApprovedWorkflowRuns(repoFullName, headSha, false),
    ];
    await probot.receive(event);

    handleScope(scope);
  });

  test("PR adds ciflow/trunk on comment", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body =
      "@clee2000 has imported this pull request. If you are a Meta employee, you can view this diff [on Phabricator](https://www.internalfb.com/diff/D64475068).";
    event.payload.comment.user.login = "facebook-github-bot";
    const owner = "clee2000";
    const repo = "random-testing";
    event.payload.repository.owner.login = owner;
    event.payload.repository.name = repo;
    const repoFullName = `${owner}/${repo}`;
    const author = event.payload.issue.user.login;
    const headSha = "random";

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const scope = [
      utils.mockGetPR(repoFullName, event.payload.issue.number, {
        user: { login: author },
        head: { sha: headSha },
        base: { repo: { name: repo, owner: { login: owner } } },
      }),
      utils.mockApprovedWorkflowRuns(repoFullName, headSha, true),
      utils.mockAddLabels(
        ["ciflow/trunk"],
        repoFullName,
        event.payload.issue.number
      ),
    ];
    await probot.receive(event);

    handleScope(scope);
  });
});
