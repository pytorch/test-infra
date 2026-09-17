import pytorchBot from "lib/bot/pytorchBot";
import * as botUtils from "lib/bot/utils";
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
    const mockbotSupportedOrg = jest.spyOn(
      botUtils,
      "isPyTorchbotSupportedOrg"
    );
    mockbotSupportedOrg.mockReturnValue(true);
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
      .get(`/repos/${owner}/${repo}/labels?per_page=100`)
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
      .get(`/repos/${owner}/${repo}/labels?per_page=100`)
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
      .get(`/repos/${owner}/${repo}/labels?per_page=100`)
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
    const comment_number = event.payload.comment.id;

    // With the new behavior, labels are still added even without approval,
    // but a comment warns that CI won't be triggered until approved.
    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/labels?per_page=100`)
      .reply(200, existingRepoLabelsResponse)
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"body":"The ciflow label(s) ciflow/trunk will be added, but CI won't be triggered`
        );
        return true;
      })
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/labels`, (body) => {
        expect(body).toMatchObject({
          labels: ["enhancement", "ciflow/trunk"],
        });
        return true;
      })
      .reply(200, {})
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(body).toMatchObject({ content: "+1" });
          return true;
        }
      )
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
      .get(`/repos/${owner}/${repo}/labels?per_page=100`)
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
      .get(`/repos/${owner}/${repo}/labels?per_page=100`)
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
      .get(`/repos/${owner}/${repo}/labels?per_page=100`)
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

  function botManagedLabelCommandEvent() {
    const event = JSON.parse(
      JSON.stringify(require("./fixtures/pull_request_comment.json"))
    );
    event.payload.comment.body = "@pytorchbot label 'in progress'";
    event.payload.repository.owner.login = "pytorch";
    event.payload.repository.name = "pytorch";
    event.payload.repository.full_name = "pytorch/pytorch";
    return event;
  }

  const botManagedRepoLabels = () => [
    ...existingRepoLabelsResponse,
    {
      name: "in progress",
      color: "ededed",
      description: "PR implementation is in progress",
    },
  ];

  function mockDevInfraMembership(login: string, status: number, body?: any) {
    return nock("https://api.github.com")
      .get(`/orgs/pytorch/teams/pytorch-dev-infra/memberships/${login}`)
      .reply(status, body);
  }

  test("bot-managed labels cannot be added with the label command", async () => {
    const event = botManagedLabelCommandEvent();
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const prNumber = event.payload.issue.number;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/labels?per_page=100`)
      .reply(200, botManagedRepoLabels())
      .post(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, (body) => {
        expect(body.body).toContain(
          "lifecycle labels are managed automatically by pytorch-bot"
        );
        expect(body.body).toContain("in progress");
        return true;
      })
      .reply(200, {});
    const membership = mockDevInfraMembership(
      event.payload.comment.user.login,
      404
    );

    await probot.receive(event);

    handleScope(membership);
    handleScope(scope);
  });

  test("a bot command author is refused without asking about membership", async () => {
    const event = botManagedLabelCommandEvent();
    event.payload.comment.user = { login: "pytorchgreenlight[bot]" };
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const prNumber = event.payload.issue.number;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/labels?per_page=100`)
      .reply(200, botManagedRepoLabels())
      .post(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, (body) => {
        expect(body.body).toContain(
          "lifecycle labels are managed automatically by pytorch-bot"
        );
        return true;
      })
      .reply(200, {});
    // Matches any membership path, not a literal one: an interceptor pinned to
    // an exact login or org goes unconsumed whenever the request differs in any
    // way, which would pass this test without proving the call was skipped.
    const membership = nock("https://api.github.com")
      .get(/\/memberships\//)
      .reply(404);

    await probot.receive(event);

    expect(membership.isDone()).toBe(false);
    handleScope(scope);
  });

  test("dev infra members can add bot-managed labels with the label command", async () => {
    const event = botManagedLabelCommandEvent();
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const prNumber = event.payload.issue.number;
    const commentId = event.payload.comment.id;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/labels?per_page=100`)
      .reply(200, botManagedRepoLabels())
      .post(`/repos/${owner}/${repo}/issues/${prNumber}/labels`, (body) => {
        expect(JSON.stringify(body)).toContain(`{"labels":["in progress"]}`);
        return true;
      })
      .reply(200, {})
      .post(
        `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {});
    const membership = mockDevInfraMembership(
      event.payload.comment.user.login,
      200,
      { state: "active" }
    );

    await probot.receive(event);

    handleScope(membership);
    handleScope(scope);
  });

  test("bot-managed labels stay refused when the team lookup fails", async () => {
    const event = botManagedLabelCommandEvent();
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const prNumber = event.payload.issue.number;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/labels?per_page=100`)
      .reply(200, botManagedRepoLabels())
      .post(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, (body) => {
        expect(body.body).toContain(
          "lifecycle labels are managed automatically by pytorch-bot"
        );
        return true;
      })
      .reply(200, {});
    const membership = mockDevInfraMembership(
      event.payload.comment.user.login,
      403,
      { message: "Forbidden" }
    );

    await probot.receive(event);

    handleScope(membership);
    handleScope(scope);
  });

  // On the pull_request_review path the handler's `login` is the PR AUTHOR, not
  // the reviewer who typed the command. These two pin the exemption to the
  // reviewer, so an author on the team cannot lend their exemption out.
  function botManagedLabelReviewEvent(
    reviewerLogin: string,
    prAuthorLogin: string
  ) {
    const event = JSON.parse(
      JSON.stringify(require("./fixtures/pull_request_review.json"))
    );
    event.payload.review.body = "@pytorchbot label 'in progress'";
    event.payload.review.user = { login: reviewerLogin };
    event.payload.pull_request.user = { login: prAuthorLogin };
    event.payload.repository.owner.login = "pytorch";
    event.payload.repository.name = "pytorch";
    event.payload.repository.full_name = "pytorch/pytorch";
    return event;
  }

  test("a non-member reviewer cannot borrow a dev infra PR author's exemption", async () => {
    const event = botManagedLabelReviewEvent(
      "outside-reviewer",
      "dev-infra-pr-author"
    );
    const prNumber = event.payload.pull_request.number;

    const scope = nock("https://api.github.com")
      .get(`/repos/pytorch/pytorch/labels?per_page=100`)
      .reply(200, botManagedRepoLabels())
      .post(`/repos/pytorch/pytorch/issues/${prNumber}/comments`, (body) => {
        expect(body.body).toContain(
          "lifecycle labels are managed automatically by pytorch-bot"
        );
        return true;
      })
      .reply(200, {});
    // Membership is asked about the REVIEWER. If the code used `this.login`
    // instead, this interceptor would go unconsumed and the author's mock below
    // would answer "active", letting the label through.
    const reviewerMembership = mockDevInfraMembership("outside-reviewer", 404);
    const authorMembership = mockDevInfraMembership(
      "dev-infra-pr-author",
      200,
      { state: "active" }
    );

    await probot.receive(event);

    expect(authorMembership.isDone()).toBe(false);
    handleScope(reviewerMembership);
    handleScope(scope);
  });

  test("a dev infra reviewer can add bot-managed labels from a review body", async () => {
    const event = botManagedLabelReviewEvent(
      "dev-infra-reviewer",
      "someone-else"
    );
    const prNumber = event.payload.pull_request.number;

    const scope = nock("https://api.github.com")
      .get(`/repos/pytorch/pytorch/labels?per_page=100`)
      .reply(200, botManagedRepoLabels())
      .post(`/repos/pytorch/pytorch/issues/${prNumber}/labels`, (body) => {
        expect(JSON.stringify(body)).toContain(`{"labels":["in progress"]}`);
        return true;
      })
      .reply(200, {})
      // useReactions is false on the review path, so the ack is a comment.
      .post(`/repos/pytorch/pytorch/issues/${prNumber}/comments`, (body) => {
        expect(body.body).toContain("+1");
        return true;
      })
      .reply(200, {});
    const membership = mockDevInfraMembership("dev-infra-reviewer", 200, {
      state: "active",
    });

    await probot.receive(event);

    handleScope(membership);
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
      .get(`/repos/${owner}/${repo}/labels?per_page=100`)
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

  test("label actionable without write permissions is rejected", async () => {
    const event = require("./fixtures/issue_comment.json");
    event.payload.comment.body = "@pytorchbot label 'actionable'";
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const issue_number = event.payload.issue.number;
    const user = event.payload.comment.user.login;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/labels?per_page=100`)
      .reply(200, existingRepoLabelsResponse)
      .get(`/repos/${owner}/${repo}/collaborators/${user}/permission`)
      .reply(200, { permission: "read" })
      .post(
        `/repos/${owner}/${repo}/issues/${issue_number}/comments`,
        (body) => {
          expect(JSON.stringify(body)).toContain(
            "Only regular contributors are expected to mark issues as actionable."
          );
          return true;
        }
      )
      .reply(200, {});

    await probot.receive(event);
    handleScope(scope);
  });
});
