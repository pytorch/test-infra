import nock from "nock";
import * as probot from "probot";
import * as utils from "./utils";
import mergeBot from "../lib/bot/mergeBot";

nock.disableNetConnect();

describe("merge-bot", () => {
  let probot: probot.Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(mergeBot);
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

  test("random pull request review no event", async () => {
    const event = require("./fixtures/pull_request_review.json");
    const scope = nock("https://api.github.com");
    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("quoted merge/revert command no event", async () => {
    const merge_event = require("./fixtures/issue_comment.json");
    merge_event.payload.comment.body = "> @pytorchbot merge";
    const revert_event = require("./fixtures/issue_comment.json");
    revert_event.payload.comment.body = "> @pytorchbot revert";
    const rebase_event = require("./fixtures/issue_comment.json");
    rebase_event.payload.comment.body = "> @pytorchbot rebase";
    const scope = nock("https://api.github.com");
    await probot.receive(merge_event);
    await probot.receive(revert_event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("merge command on issue triggers confused reaction", async () => {
    const event = require("./fixtures/issue_comment.json");
    event.payload.comment.body = "@pytorchbot merge";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const comment_id = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"confused"}');
          return true;
        }
      )
      .reply(200, {});

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("merge command on pull request triggers dispatch and like", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;
    const comment_id = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(body.event_type).toBe("try-merge");
        expect(body.client_payload).toMatchObject({
          pr_num,
          comment_id,
          force: false,
          on_green: false,
          all_green: false,
        });
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("merge -f on pull request triggers dispatch and like", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -f";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;
    const comment_id = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(body.event_type).toBe("try-merge");
        expect(body.client_payload).toMatchObject({
          pr_num,
          comment_id,
          force: true,
          on_green: false,
          all_green: false,
        });
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("merge -g command on pull request triggers dispatch and like", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -g";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;
    const comment_id = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(body.event_type).toBe("try-merge");
        expect(body.client_payload).toMatchObject({
          pr_num,
          comment_id,
          force: false,
          on_green: true,
          all_green: false,
        });
        return true;
      })
      .reply(200, {});
    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("merge this command raises an error", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge this";
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_num}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain("error: unrecognized arguments");
        return true;
      })
      .reply(200);

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("revert command w/o explanation on pull request triggers comment only", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot revert";
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_num}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "the following arguments are required"
        );
        return true;
      })
      .reply(200);

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("revert command w/ explanation on pull request triggers dispatch and like", async () => {
    const event = require("./fixtures/pull_request_comment.json");
    const reason =
      "--breaks master: " +
      "https://hud.pytorch.org/minihud?name_filter=trunk%20/%20ios-12-5-1-x86-64-coreml%20/%20build";
    event.payload.comment.body = `@pytorchbot revert -m='${reason}'`;

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;
    const comment_id = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(body.event_type).toBe("try-revert");
        expect(body.client_payload).toMatchObject({
          pr_num,
          comment_id,
          reason,
        });
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("rebase command on pull request triggers dispatch and like", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot rebase";
    event.payload.comment.user.login = "clee2000";
    event.payload.issue.user.login = "random";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;
    const comment_id = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .get(`/orgs/pytorch/memberships/${event.payload.comment.user.login}`)
      .reply(200, {
        state: "active",
      })
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain(`{"content":"+1"}`);
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(body.event_type).toBe("try-rebase");
        expect(body.client_payload).toMatchObject({
          pr_num,
          comment_id,
          branch: "master",
        });
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("rebase to viable/strict", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot rebase -s";
    event.payload.comment.user.login = "random1";
    event.payload.issue.user.login = "random2";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;
    const comment_id = event.payload.comment.id;

    const scope = nock("https://api.github.com")
      .get(`/orgs/pytorch/memberships/${event.payload.comment.user.login}`)
      .reply(200, {
        state: "active",
      })
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain(`{"content":"+1"}`);
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(body.event_type).toBe("try-rebase");
        expect(body.client_payload).toMatchObject({
          pr_num,
          comment_id,
          branch: "viable/strict",
        });
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("rebase to any branch", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot rebase -b randombranch";
    event.payload.comment.user.login = "random1";
    event.payload.issue.user.login = "random2";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;
    const comment_id = event.payload.comment.id;

    const scope = nock("https://api.github.com")
      .get(`/orgs/pytorch/memberships/${event.payload.comment.user.login}`)
      .reply(200, {
        state: "active",
      })
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain(`{"content":"+1"}`);
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(body.event_type).toBe("try-rebase");
        expect(body.client_payload).toMatchObject({
          pr_num,
          comment_id,
          branch: "randombranch",
        });
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("rebase fail because -b and -s", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot rebase -b randombranch -s";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_num}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "@pytorchbot rebase: error: argument -s/--stable: not allowed with argument -b/--branch"
        );
        return true;
      })
      .reply(200);

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("rebase does not have permissions", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot rebase";
    event.payload.comment.user.login = "random1";
    event.payload.issue.user.login = "random2";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;
    const scope = nock("https://api.github.com")
      .get(`/orgs/pytorch/memberships/${event.payload.comment.user.login}`)
      .reply(404, {
        message: "Not Found",
      })
      .post(`/repos/${owner}/${repo}/issues/${pr_num}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "You don't have permissions to rebase this PR, only the PR author and pytorch organization members may rebase this PR."
        );
        return true;
      })
      .reply(200);

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("merge this pull request review triggers dispatch and +1 comment", async () => {
    const event = require("./fixtures/pull_request_review.json");

    event.payload.review.body = "@pytorchbot merge this";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.pull_request.number;
    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_num}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain('{"body":"+1"}');
        return true;
      })
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_num}}}`
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

  test("merge on green using CLI", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -g";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;
    const comment_id = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(body.event_type).toBe("try-merge");
        expect(body.client_payload).toMatchObject({
          pr_num,
          comment_id,
          force: false,
          on_green: true,
          all_green: false,
        });
        return true;
      })
      .reply(200, {});
    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("merge using CLI + other content in comment", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = `esome text
@pytorchbot merge

some other text lol
`;

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;
    const comment_id = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(body.event_type).toBe("try-merge");
        expect(body.client_payload).toMatchObject({
          pr_num,
          comment_id,
          force: false,
          on_green: false,
          all_green: false,
        });
        return true;
      })
      .reply(200, {});
    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("force merge using CLI", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -f";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;
    const comment_id = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(body.event_type).toBe("try-merge");
        expect(body.client_payload).toMatchObject({
          pr_num,
          comment_id,
          force: true,
          on_green: false,
          all_green: false,
        });
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("merge on all green using CLI", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge --all-green";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;
    const comment_id = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(body.event_type).toBe("try-merge");
        expect(body.client_payload).toMatchObject({
          pr_num,
          comment_id,
          force: false,
          on_green: false,
          all_green: true,
        });
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("help using CLI", async () => {
    const event = require("./fixtures/pull_request_comment.json");

    event.payload.comment.body = `@pytorchbot help`;
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_num}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain("# PyTorchBot Help");
        return true;
      })
      .reply(200);

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("revert using CLI", async () => {
    const event = require("./fixtures/pull_request_comment.json");
    const reason = "this is breaking test_meta";
    event.payload.comment.body =
      '@pytorchbot revert -m="' + reason + '" -c="ghfirst"';

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_num = event.payload.issue.number;
    const comment_id = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(body.event_type).toBe("try-revert");
        expect(body.client_payload).toMatchObject({
          pr_num,
          comment_id,
          reason,
        });
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("Random commands won't trigger CLI", async () => {
    const eventCantMerge = require("./fixtures/pull_request_comment.json");
    const eventWithQuotes = require("./fixtures/pull_request_comment.json");
    const eventQuoted = require("./fixtures/pull_request_comment.json");

    eventCantMerge.payload.comment.body = "Can't merge closed PR #77376";
    eventWithQuotes.payload.comment.body = `"@pytorchbot merge" use this command`;
    eventQuoted.payload.comment.body = `> @pytorchbot merge -f`;

    const scope = nock("https://api.github.com");
    await probot.receive(eventCantMerge);
    await probot.receive(eventWithQuotes);
    await probot.receive(eventQuoted);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });
});
