import nock from "nock";
import * as probot from "probot";
import * as utils from "./utils";
import pytorchBot from "../lib/bot/pytorchBot";
import { handleScope, requireDeepCopy } from "./common";
import { getFailureMessage, getMessage } from "lib/GeneralUtils";

nock.disableNetConnect();

describe("merge-bot", () => {
  let probot: probot.Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(pytorchBot);
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("random pr comment no reaction", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    const scope = nock("https://api.github.com");
    await probot.receive(event);
    handleScope(scope);
  });

  test("random issue comment no event", async () => {
    const event = requireDeepCopy("./fixtures/issue_comment.json");
    const scope = nock("https://api.github.com");
    await probot.receive(event);
    handleScope(scope);
  });

  test("random pull request review no event", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_review.json");
    const scope = nock("https://api.github.com");
    await probot.receive(event);
    handleScope(scope);
  });

  test("quoted merge/revert command no event", async () => {
    const merge_event = requireDeepCopy("./fixtures/issue_comment.json");
    merge_event.payload.comment.body = "> @pytorchbot merge";
    const revert_event = requireDeepCopy("./fixtures/issue_comment.json");
    revert_event.payload.comment.body = "> @pytorchbot revert";
    const rebase_event = requireDeepCopy("./fixtures/issue_comment.json");
    rebase_event.payload.comment.body = "> @pytorchbot rebase";
    const scope = nock("https://api.github.com");
    await probot.receive(merge_event);
    await probot.receive(revert_event);
    handleScope(scope);
  });

  test("merge command on issue triggers confused reaction", async () => {
    const event = requireDeepCopy("./fixtures/issue_comment.json");
    event.payload.comment.body = "@pytorchbot merge";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
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

  test("merge command on pytorch/pytorch pull request triggers label, dispatch and like", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge";
    event.payload.repository.owner.login = "pytorch";
    event.payload.repository.name = "pytorch";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/labels`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `"labels":["ciflow/trunk"]`
        );
        return true;
      })
      .reply(200, {})
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number}}}`
        );
        return true;
      })
      .reply(200, {})
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}/reviews`)
      .reply(200, requireDeepCopy("./fixtures/pull_request_reviews.json"));

    await probot.receive(event);
    handleScope(scope);
  });

  test("merge command on pull request triggers dispatch and like", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number}}}`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    handleScope(scope);
  });

  test("merge -f on pull request triggers permission checks, dispatch and like", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -f '[MINOR] Fix lint'";
    event.payload.repository.owner.login = "pytorch";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"force":true}}`
        );
        return true;
      })
      .reply(200, {})
      .get(`/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`)
      .reply(200, {'permission': "write" });

    await probot.receive(event);
    handleScope(scope);
  });

  test("merge -f with a minimal acceptable message (2 words)", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -f 'Fix lint'";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"force":true}}`
        );
        return true;
      })
      .reply(200, {})
      .get(`/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`)
      .reply(200, {'permission': "write" });

    await probot.receive(event);
    handleScope(scope);
  });

  test("reject merge -f without a reason", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -f";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "@pytorchbot merge: error: argument -f/--force: expected one argument"
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    handleScope(scope);
  });

  test("reject merge -f without write access", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -f 'cuz I want to'";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"confused"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "You are not authorized"
        );
        return true;
      })
      .reply(200, {})
      .get(`/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`)
      .reply(200, {'permission': "read" });

    await probot.receive(event);
    handleScope(scope);
  });

  test("reject merge -f with an empty reason", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -f ''";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"confused"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "You need to provide a reason for using force merge"
        );
        return true;
      })
      .reply(200, {})
      .get(`/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`)
      .reply(200, {'permission': "write" });

    await probot.receive(event);
    handleScope(scope);
  });

  test("reject merge -f with a too short reason (< 2 words)", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -f 'YOLO'";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"confused"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "You need to provide a reason for using force merge"
        );
        return true;
      })
      .reply(200, {})
      .get(`/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`)
      .reply(200, {'permission': "write" });

    await probot.receive(event);
    handleScope(scope);
  });

  test("merge -ic command on pull request triggers dispatch and like", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -ic";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"ignore_current":true}}`
        );
        return true;
      })
      .reply(200, {});
    await probot.receive(event);

    handleScope(scope);
  });

  test("merge this command raises an error", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge this";
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain("error: unrecognized arguments");
        return true;
      })
      .reply(200);

    await probot.receive(event);

    handleScope(scope);
  });

  test("revert command w/o explanation on pull request triggers comment only", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot revert";
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "the following arguments are required"
        );
        return true;
      })
      .reply(200);

    await probot.receive(event);

    handleScope(scope);
  });

  test("revert command on HUD", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    const msg = getMessage(
      "this is breaking stuff on trunk",
      "nosignal",
      getFailureMessage(
        {
          sha: "sha",
          time: "",
          commitUrl: "",
          commitTitle: "",
          commitMessageBody: "",
          author: "randomPerson",
          authorUrl: "",
          prNum: 5,
          diffNum: null,
        },
        []
      )
    );
    event.payload.comment.body = msg;

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-revert","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);

    handleScope(scope);
  });
  test("revert command w/ explanation on pull request triggers dispatch and like", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    const reason =
      "--breaks master: " +
      "https://hud.pytorch.org/minihud?name_filter=trunk%20/%20ios-12-5-1-x86-64-coreml%20/%20build";

    event.payload.comment.body = `@pytorchbot revert -m='${reason}' -c landrace`;

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-revert","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"reason":"${reason.replace(
            /\n/g,
            "\\n"
          )}"}}`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);

    handleScope(scope);
  });

  test("rebase command on pull request triggers dispatch and like", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot rebase";
    event.payload.comment.user.login = "clee2000";
    event.payload.issue.user.login = "random";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`
      )
      .reply(200, { permission: "write" })
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain(`{"content":"+1"}`);
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-rebase","client_payload":{"pr_num":${pr_number}`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);

    handleScope(scope);
  });

  test("rebase to viable/strict", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot rebase -s";
    event.payload.comment.user.login = "random1";
    event.payload.issue.user.login = "random2";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;

    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`
      )
      .reply(200, { permission: "write" })
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain(`{"content":"+1"}`);
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-rebase","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"branch":"viable/strict"}}`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);

    handleScope(scope);
  });

  test("rebase to any branch", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot rebase -b randombranch";
    event.payload.comment.user.login = "random1";
    event.payload.issue.user.login = "random2";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;

    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`
      )
      .reply(200, { permission: "write" })
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain(`{"content":"+1"}`);
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-rebase","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"branch":"randombranch"}}`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);

    handleScope(scope);
  });

  test("merge fail because mutually exclusive options", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -ic -f '[MINOR] Fix lint'";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "@pytorchbot merge: error: argument -f/--force: not allowed with argument -ic/--ignore-current"
        );
        return true;
      })
      .reply(200);

    await probot.receive(event);

    handleScope(scope);
  });

  test("merge fail because mutually exclusive options without force merge reason", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -ic -f";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "@pytorchbot merge: error: argument -f/--force: expected one argument"
        );
        return true;
      })
      .reply(200);

    await probot.receive(event);

    handleScope(scope);
  });

  test("rebase fail because -b and -s", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot rebase -b randombranch -s";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "@pytorchbot rebase: error: argument -s/--stable: not allowed with argument -b/--branch"
        );
        return true;
      })
      .reply(200);

    await probot.receive(event);

    handleScope(scope);
  });

  test("rebase does not have permissions", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot rebase";
    event.payload.comment.user.login = "random1";
    event.payload.issue.user.login = "random2";

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
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "You don't have permissions to rebase this PR"
        );
        return true;
      })
      .reply(200);

    await probot.receive(event);

    handleScope(scope);
  });

  test("rebase no write permissions but has committed before", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot rebase";
    event.payload.comment.user.login = "random1";
    event.payload.issue.user.login = "random2";

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
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain(`{"content":"+1"}`);
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-rebase","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"branch":"viable/strict"}}`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);

    handleScope(scope);
  });

  test("merge this pull request review triggers dispatch and +1 comment in pytorch org", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_review.json");
    event.payload.pull_request.user.login = "randomuser";
    event.payload.review.body = "@pytorchbot merge";
    event.payload.repository.owner.login = "pytorch";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.pull_request.number;
    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain('{"body":"+1"}');
        return true;
      })
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":`
        );
        return true;
      })
      .reply(200, {})
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}/reviews`)
      .reply(200, requireDeepCopy("./fixtures/pull_request_reviews.json"));

    await probot.receive(event);

    handleScope(scope);
  });

  test("Revert pull request review triggers dispatch and +1 comment", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_review.json");
    event.payload.pull_request.user.login = "randomuser";
    event.payload.review.body =
      "@pytorchbot revert -m 'this is a bad pr' -c 'nosignal'";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.pull_request.number;
    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain('{"body":"+1"}');
        return true;
      })
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-revert","client_payload":{"pr_num":${pr_number},"comment_id":`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);

    handleScope(scope);
  });

  test("merge with ignore current flag using CLI", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchmergebot merge -ic";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"ignore_current":true}}`
        );
        return true;
      })
      .reply(200, {});
    await probot.receive(event);

    handleScope(scope);
  });

  test("merge with land checks using CLI in pytorch org", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchmergebot merge";
    event.payload.repository.owner.login = "pytorch";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number}}}`
        );
        return true;
      })
      .reply(200, {})
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}/reviews`)
      .reply(200, requireDeepCopy("./fixtures/pull_request_reviews.json"));
    await probot.receive(event);

    handleScope(scope);
  });

  test("merge using CLI + other content in comment", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = `esome text
@pytorchbot merge

some other text lol
`;

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number}}}`
        );
        return true;
      })
      .reply(200, {});
    await probot.receive(event);
    handleScope(scope);
  });

  test("force merge using CLI", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -f '[MINOR] Fix lint'";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"force":true}}`
        );
        return true;
      })
      .reply(200, {})
      .get(`/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`)
      .reply(200, {'permission': "write" });

    await probot.receive(event);
    handleScope(scope);
  });

  test("merge rebase default", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -r";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`
      )
      .reply(200, { permission: "write" })
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"rebase":"viable/strict"}}`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    handleScope(scope);
  });

  test("merge rebase main", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -r main";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .get(
        `/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`
      )
      .reply(200, { permission: "write" })
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"rebase":"main"}}`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    handleScope(scope);
  });

  test("merge rebase no permissions", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -r";

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
      .reply(200, [])
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "You don't have permissions to rebase this PR since"
        );
        return true;
      })
      .reply(200)
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number}}}`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    handleScope(scope);
  });

  test("merge rebase no write permissions but has committed before", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -r";

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
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"rebase":"viable/strict"}}`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    handleScope(scope);
  });

  test("merge rebase invalid branch", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = "@pytorchbot merge -r something";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "@pytorchbot merge: error: argument -r/--rebase: invalid choice: 'something' (choose from 'viable/strict', 'main')"
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    handleScope(scope);
  });

  test("help using CLI", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");

    event.payload.comment.body = `@pytorchbot --help`;
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain("# PyTorchBot Help");
        return true;
      })
      .reply(200);

    await probot.receive(event);
    handleScope(scope);
  });

  async function handleRevertTest(commentBody: string, reason: string) {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = commentBody;

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-revert","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number},"reason":"${reason}"}}`
        );
        return true;
      })
      .reply(200, {});

    await probot.receive(event);
    handleScope(scope);
  }
  test("revert using @pytorchmergebot CLI", async () => {
    const reason = "this is breaking test_meta";
    await handleRevertTest(
      '@pytorchmergebot revert -m="' + reason + '" -c="ghfirst"',
      reason
    );
  });

  test("revert using CLI", async () => {
    const reason = "this is breaking test_meta";
    await handleRevertTest(
      '@pytorchbot revert -m="' + reason + '" -c="ghfirst"',
      reason
    );
  });

  test("Random commands won't trigger CLI", async () => {
    const eventCantMerge = requireDeepCopy(
      "./fixtures/pull_request_comment.json"
    );
    const eventWithQuotes = requireDeepCopy(
      "./fixtures/pull_request_comment.json"
    );
    const eventQuoted = requireDeepCopy("./fixtures/pull_request_comment.json");
    const testCommand = requireDeepCopy("./fixtures/pull_request_comment.json");

    eventCantMerge.payload.comment.body = "Can't merge closed PR #77376";
    eventWithQuotes.payload.comment.body = `"@pytorchbot merge" use this command`;
    eventQuoted.payload.comment.body = `> @pytorchbot merge -f`;

    const scope = nock("https://api.github.com");
    await probot.receive(eventCantMerge);
    await probot.receive(eventWithQuotes);
    await probot.receive(eventQuoted);

    handleScope(scope);
  });

  test("A PR with only requested changes doesn't trigger the merge workflow in PyTorch org", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "@pytorchbot merge";
    event.payload.repository.owner.login = "pytorch";

    const pull_requests = requireDeepCopy("./fixtures/pull_request_reviews.json");
    pull_requests[0].state = "CHANGES_REQUESTED"
    pull_requests[2].state = "CHANGES_REQUESTED"

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}/reviews`)
      .reply(200, pull_requests)
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"confused"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "This PR needs to be approved"
        );
        return true;
      })
      .reply(200);
    await probot.receive(event);

    handleScope(scope);
  });

  test("An approval is prioritized over a PR rejection in pytorch org", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "@pytorchbot merge";
    event.payload.repository.owner.login = "pytorch";

    const pull_requests = requireDeepCopy("./fixtures/pull_request_reviews.json");
    pull_requests[0].state = "CHANGES_REQUESTED"
    pull_requests[1].state = "APPROVED"

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}/reviews`)
      .reply(200, pull_requests)
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/dispatches`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `{"event_type":"try-merge","client_payload":{"pr_num":${pr_number},"comment_id":${comment_number}}}`
        );
        return true;
      })
      .reply(200, {})
    await probot.receive(event);

    handleScope(scope);
  });

  test("Comment only workflows don't let a PR get merged in pytorch org", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "@pytorchbot merge";
    event.payload.repository.owner.login = "pytorch";

    const pull_requests = requireDeepCopy("./fixtures/pull_request_reviews.json");
    pull_requests[0].state = "COMMENTED"
    pull_requests[1].state = "COMMENTED"
    pull_requests[2].state = "COMMENTED"

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}/reviews`)
      .reply(200, pull_requests)
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"confused"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "This PR needs to be approved"
        );
        return true;
      })
      .reply(200);
    await probot.receive(event);

    handleScope(scope);
  });

  test("Zero Reviews in PyTorch org blocks the merge", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "@pytorchbot merge";
    event.payload.repository.owner.login = "pytorch";

    const pull_requests: any[] = []

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;
    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}/reviews`)
      .reply(200, pull_requests)
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"confused"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "This PR needs to be approved"
        );
        return true;
      })
      .reply(200);
    await probot.receive(event);

    handleScope(scope);
  });

  test("Approvals from unauthorized users don't count in pytorch org", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_comment.json");
    event.payload.comment.body = "@pytorchbot merge";
    event.payload.repository.owner.login = "pytorch";

    const pull_requests = requireDeepCopy("./fixtures/pull_request_reviews.json");
    pull_requests[0].author_association = "FIRST_TIME_CONTRIBUTOR"
    pull_requests[1].author_association = "FIRST_TIME_CONTRIBUTOR"
    pull_requests[2].author_association = "FIRST_TIME_CONTRIBUTOR"

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.issue.number;
    const comment_number = event.payload.comment.id;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}/reviews`)
      .reply(200, pull_requests)
      .post(
        `/repos/${owner}/${repo}/issues/comments/${comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"confused"}');
          return true;
        }
      )
      .reply(200, {})
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          "This PR needs to be approved"
        );
        return true;
      })
      .reply(200);
    await probot.receive(event);

    handleScope(scope);
  });
});
