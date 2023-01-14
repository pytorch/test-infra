import nock from "nock";
import * as probot from "probot";
import * as utils from "./utils";
import pytorchBot from "lib/bot/pytorchBot";
import { handleScope } from "./common";

nock.disableNetConnect();

describe("label-bot", () => {
  let probot: probot.Probot;

  const existingRepoLabelsResponse = require("./fixtures/known_labels.json");

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(pytorchBot);
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("random pr comment no reactoin", async () => {
    const event = require("./fixtures/pull_request_comment.json");
    const scope = nock("https://api.github.com");
    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("random issue comment no event", async () => {
    const event = require("./fixtures/issue_comment.json");
    const scope = nock("https://api.github.com");
    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("label comment with one label on pull request triggers add label and like", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot label enhancement";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/labels`)
      .reply(200, existingRepoLabelsResponse)
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/labels`, (body) => {
        expect(JSON.stringify(body)).toContain(`{"labels":["enhancement"]}`);
        return true;
      })
      .reply(200, {});
    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("label comment with several labels(valid and invalid) on pull request triggers add label and like", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body =
      "@pytorchbot label enhancement  'good first issue'   test:111";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/labels`)
      .reply(200, existingRepoLabelsResponse)
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/labels`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"labels":["enhancement","good first issue"]}`
        );
        return true;
      })
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          '{"body":"Didn\'t find following labels among repository labels: test:111"}'
        );
        return true;
      })
      .reply(200, {});
    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("label with ciflow bad permissions", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot label enhancement 'ciflow/trunk'";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const default_branch = event.payload.repository.default_branch;

    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`
      )
      .reply(200, { permission: "read" })
      .get(
        `/repos/${owner}/${repo}/commits?author=${event.payload.comment.user.login}&sha=${default_branch}&per_page=1`
      )
      .reply(200, [])
      .get(`/repos/${owner}/${repo}/labels`)
      .reply(200, existingRepoLabelsResponse)
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"body":"Can't add following labels to PR: ciflow/trunk`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    handleScope(scope);
  });

  test("label with ciflow good permissions", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot label 'ciflow/trunk'";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const default_branch = event.payload.repository.default_branch;

    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`
      )
      .reply(200, { permission: "read" })
      .get(
        `/repos/${owner}/${repo}/commits?author=${event.payload.comment.user.login}&sha=${default_branch}&per_page=1`
      )
      .reply(200, [{}])
      .get(`/repos/${owner}/${repo}/labels`)
      .reply(200, existingRepoLabelsResponse)
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/labels`, (body) => {
        expect(JSON.stringify(body)).toContain(`{"labels":["ciflow/trunk"]}`);
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    handleScope(scope);
  });
});
