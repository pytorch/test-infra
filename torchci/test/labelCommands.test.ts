import pytorchBot from "lib/bot/pytorchBot";
import nock from "nock";
import * as probot from "probot";
import { handleScope } from "./common";
import * as utils from "./utils";

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

  test("random pr comment no reaction", async () => {
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

  test("issue comment with one valid label", async () => {
    const event = require("./fixtures/issue_comment.json");

    event.payload.comment.body = "@pytorchbot label enhancement";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const issue_number = event.payload.issue.number;
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
      .post(`/repos/${owner}/${repo}/issues/${issue_number}/labels`, (body) => {
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

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/labels`)
      .reply(200, existingRepoLabelsResponse)
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"body":"To add these label(s) (ciflow/trunk`
        );
        return true;
      })
      .reply(200, {});
    const additionalScopes = [
      utils.mockPermissions(
        `${owner}/${repo}`,
        event.payload.comment.user.login,
        "read"
      ),
      utils.mockGetPR(`${owner}/${repo}`, pr_number, {
        head: { sha: "randomsha" },
      }),
      utils.mockApprovedWorkflowRuns(`${owner}/${repo}`, "randomsha", false),
    ];

    await probot.receive(event);
    handleScope(scope);
    handleScope(additionalScopes);
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
    const additionalScopes = [
      utils.mockPermissions(
        `${owner}/${repo}`,
        event.payload.comment.user.login,
        "read"
      ),
      utils.mockGetPR(`${owner}/${repo}`, pr_number, {
        head: { sha: "randomsha" },
      }),
      utils.mockApprovedWorkflowRuns(`${owner}/${repo}`, "randomsha", true),
    ];

    await probot.receive(event);
    handleScope(scope);
    handleScope(additionalScopes);
  });

  test("label requiring write access with bad permissions", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot label 'skip-pr-sanity-check'";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const user = event.payload.comment.user.login;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/labels`)
      .reply(200, existingRepoLabelsResponse)
      .get(`/repos/${owner}/${repo}/collaborators/${user}/permission`)
      .reply(200, {
        permission: "read",
      })
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"body":"Only people with write access to the repo can add these labels`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    handleScope(scope);
  });

  test("label requiring write access with good permissions", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot label 'skip-pr-sanity-check'";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const user = event.payload.comment.user.login;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/labels`)
      .reply(200, existingRepoLabelsResponse)
      .get(`/repos/${owner}/${repo}/collaborators/${user}/permission`)
      .reply(200, {
        permission: "write",
      })
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
          `{"labels":["skip-pr-sanity-check"]}`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    handleScope(scope);
  });

  test("label with ciflow on issue should have no event", async () => {
    const event = require("./fixtures/issue_comment.json");
    event.payload.comment.body = "@pytorchbot label 'ciflow/trunk'";
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const issue_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/labels`)
      .reply(200, existingRepoLabelsResponse)
      .post(
        `/repos/${owner}/${repo}/issues/${issue_number}/comments`,
        (body) => {
          expect(JSON.stringify(body)).toContain(
            `{"body":"Can't add ciflow labels to an Issue.`
          );
          return true;
        }
      )
      .reply(200, {})
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"confused"}');
          return true;
        }
      )
      .reply(200, {});

    await probot.receive(event);
    handleScope(scope);
  });
});
