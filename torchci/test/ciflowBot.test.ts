import nock from "nock";
import * as probot from "probot";
import * as utils from "./utils";
import CIFlowBot, { Ruleset } from "../lib/bot/ciflowBot";
import { nockTracker } from "./common";

nock.disableNetConnect();
jest.setTimeout(60000); // 60 seconds

describe("CIFlowBot Unit Tests", () => {
  const pr_number = 5;
  const owner = "pytorch";
  const repo = "pytorch";

  beforeEach(() => {
    jest
      .spyOn(CIFlowBot.prototype, "getUserPermission")
      .mockResolvedValue("write");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("parseContext for pull_request.opened", async () => {
    const event = require("./fixtures/pull_request.opened.json");
    event.payload.pull_request.number = pr_number;
    event.payload.repository.owner.login = owner;
    event.payload.repository.name = repo;

    // @ts-ignore
    const ciflow = new CIFlowBot(new probot.Context(event, null, null));
    const isValid = await ciflow.setContext();
    expect(isValid).toBe(true);
  });

  test("parseContext for pull_request.reopened", async () => {
    const event = require("./fixtures/pull_request.reopened.json");
    event.payload.pull_request.number = pr_number;
    event.payload.repository.owner.login = owner;
    event.payload.repository.name = repo;

    // @ts-ignore
    const ciflow = new CIFlowBot(new probot.Context(event, null, null));
    const isValid = await ciflow.setContext();
    expect(isValid).toBe(true);
  });

  describe("parseContext for issue_comment.created with valid or invalid comments", () => {
    const event = require("./fixtures/issue_comment.json");

    beforeEach(() => {
      event.payload.issue.number = pr_number;
      event.payload.repository.owner.login = owner;
      event.payload.repository.name = repo;
      event.payload.comment.user.login = event.payload.issue.user.login;
    });

    const validComments = [
      `@${CIFlowBot.bot_assignee} ciflow rerun`,
      `@${CIFlowBot.bot_assignee} ciflow rerun `,
      `   @${CIFlowBot.bot_assignee} ciflow rerun`,
      `   @${CIFlowBot.bot_assignee}     ciflow rerun`,
      `   @${CIFlowBot.bot_assignee}     ciflow   rerun`,
      `   @${CIFlowBot.bot_assignee}     ciflow   rerun    `,
      `Some other comments, \n@${CIFlowBot.bot_assignee} ciflow rerun`,
      `Some other comments, \n   @${CIFlowBot.bot_assignee} ciflow rerun`,
      `Some other comments, \n@${CIFlowBot.bot_assignee}    ciflow rerun`,
      `Some other comments, \n@${CIFlowBot.bot_assignee} ciflow    rerun`,
      `Some other comments, \n@${CIFlowBot.bot_assignee} ciflow rerun -l ciflow/slow`,
      `Some other comments, \n@${CIFlowBot.bot_assignee} ciflow rerun -l ciflow/slow -l ciflow/scheduled`,
      `Some other comments, \n@${CIFlowBot.bot_assignee} ciflow rerun -l     ciflow/slow`, // with spaces
      `Some other comments, \n@${CIFlowBot.bot_assignee} ciflow rerun -l     ciflow/slow -l ciflow/scheduled`,
      `Some other comments, \n@${CIFlowBot.bot_assignee} ciflow rerun\nNew comments\n`,
    ];
    test.each(validComments)(
      `valid comment: %s`,
      async (validComment: string) => {
        event.payload.comment.body = validComment;
        // @ts-ignore
        const ciflow = new CIFlowBot(new probot.Context(event, null, null));
        const isValid = await ciflow.setContext();
        expect(isValid).toBe(true);
        expect(ciflow.confusing_command).toBe(false);
      }
    );

    const invalidComments = [
      `invalid`,
      `@${CIFlowBot.bot_assignee}`, // without commands appended after the @assignee
      `@${CIFlowBot.bot_assignee} ciflow`, // without subcommand rerun
    ];
    test.each(invalidComments)(
      "invalid comment: %s",
      async (invalidComment: string) => {
        event.payload.comment.body = invalidComment;
        // @ts-ignore
        const ciflow = new CIFlowBot(new probot.Context(event, null, null));
        const isValid = await ciflow.setContext();
        expect(isValid).toBe(false);
      }
    );
    const confusingComments = [
      `@${CIFlowBot.bot_assignee} ciflow rerun again`, // two subcommands
      `@${CIFlowBot.bot_assignee} ciflow rerun -m foo`, // subcommand with invalid flag
      `@${CIFlowBot.bot_assignee} ciflow rerun -l`, // rerun -l with no args
      `@${CIFlowBot.bot_assignee} ciflow rerun -l 1`, // rerun -l with integer arg
      `@${CIFlowBot.bot_assignee} ciflow rerun -l meow`, // rerun -l with integer arg
    ];
    test.each(confusingComments)(
      "confusing comment: %s",
      async (confusingComment: string) => {
        event.payload.comment.body = confusingComment;
        // @ts-ignore
        const ciflow = new CIFlowBot(new probot.Context(event, null, null));
        const isValid = await ciflow.setContext();
        expect(isValid).toBe(true);
        expect(ciflow.confusing_command).toBe(true);
      }
    );
  });

  test("parseContext for issue_comment.created with comment author that has write permission", async () => {
    const event = require("./fixtures/issue_comment.json");
    event.payload.issue.number = pr_number;
    event.payload.repository.owner.login = owner;
    event.payload.repository.name = repo;
    event.payload.comment.body = `@${CIFlowBot.bot_assignee} ciflow rerun`;
    event.payload.comment.user.login = "non-exist-user";

    // @ts-ignore
    const ciflow = new CIFlowBot(new probot.Context(event, null, null));
    jest.spyOn(ciflow, "getUserPermission").mockResolvedValue("write");
    const isValid = await ciflow.setContext();
    expect(isValid).toBe(true);
  });

  test("parseContext for issue_comment.created with comment author that has read permission", async () => {
    const event = require("./fixtures/issue_comment.json");
    event.payload.issue.number = pr_number;
    event.payload.repository.owner.login = owner;
    event.payload.repository.name = repo;
    event.payload.comment.body = `@${CIFlowBot.bot_assignee} ciflow rerun`;
    event.payload.comment.user.login = "non-exist-user";

    // @ts-ignore
    const ciflow = new CIFlowBot(new probot.Context(event, null, null));
    jest.spyOn(ciflow, "getUserPermission").mockResolvedValue("read");
    const isValid = await ciflow.setContext();
    expect(isValid).toBe(false);
  });
  /*
  test('parseContext for issue_comment.created invalid owner/repo', async () => {
    const event = require('./fixtures/issue_comment.json');
    event.payload.issue.number = pr_number;
    event.payload.repository.owner.login = 'invalid';
    event.payload.repository.name = 'invalid';
    event.payload.comment.body = `@${CIFlowBot.bot_assignee} ciflow rerun`;
    event.payload.comment.user.login = event.payload.issue.user.login;

    const ciflow = new CIFlowBot(new probot.Context(event, null, null));
    const isValid = await ciflow.setContext();
    expect(isValid).toBe(false);
  });
 */
});

describe("CIFlowBot Integration Tests", () => {
  let p: probot.Probot;
  const pr_number = 5;
  const owner = "pytorch";
  const repo = "pytorch";
  const comment_id = 10;

  beforeEach(() => {
    p = utils.testProbot();
    p.load(CIFlowBot.main);

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    nockTracker(
      `
                @zzj-bot
                @octocat ciflow/default cats
                -@opt-out-users`,
      "pytorch/pytorch",
      "ciflow_tracking_issue: 6"
    );

    // @ts-ignore
    jest.spyOn(Ruleset.prototype, "upsertRootComment").mockReturnValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("pull_request.opened event: add_default_labels strategy happy path", async () => {
    const event = require("./fixtures/pull_request.opened.json");
    event.payload.pull_request.number = pr_number;
    event.payload.repository.owner.login = owner;
    event.payload.repository.name = repo;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/labels`, (body) => {
        expect(body).toMatchObject({ labels: ["ciflow/default"] });
        return true;
      })
      .reply(200);

    await p.receive(event);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("pull_request.opened event: add_default_labels strategy for a_random_user", async () => {
    const event = require("./fixtures/pull_request.opened.json");
    event.payload.pull_request.number = pr_number;
    event.payload.pull_request.user.login = "a_random_user";
    event.payload.repository.owner.login = owner;
    event.payload.repository.name = repo;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/labels`, (body) => {
        expect(body).toMatchObject({ labels: ["ciflow/default"] });
        return true;
      })
      .reply(200);

    await p.receive(event);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("pull_request.opened event: respect opt-out users", async () => {
    const event = require("./fixtures/pull_request.opened.json");
    event.payload.pull_request.number = pr_number;
    event.payload.pull_request.user.login = "opt-out-users";
    event.payload.repository.owner.login = owner;
    event.payload.repository.name = repo;

    const scope = nock("https://api.github.com");
    await p.receive(event);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("pull_request.opened event: do not override pre-existing labels", async () => {
    const event = require("./fixtures/pull_request.opened.json");
    event.payload.pull_request.number = pr_number;
    event.payload.pull_request.labels = [{ name: "ciflow/eeklo" }];
    event.payload.repository.owner.login = owner;
    event.payload.repository.name = repo;

    const scope = nock("https://api.github.com");
    await p.receive(event);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("pull_request.opened event: add_default_labels strategy not rolled out", async () => {
    const event = require("./fixtures/pull_request.opened.json");
    event.payload.pull_request.user.login = "rumpelstiltskin";
    event.payload.pull_request.number = pr_number;
    event.payload.repository.owner.login = owner;
    event.payload.repository.name = repo;

    const scope = nock("https://api.github.com");
    await p.receive(event);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  describe("issue_comment.created event: add_default_labels strategy happy path", () => {
    const event = require("./fixtures/issue_comment.json");

    beforeEach(() => {
      event.payload.issue.number = pr_number;
      event.payload.repository.owner.login = owner;
      event.payload.repository.name = repo;
      event.payload.comment.user.login = "non-exist-user";
      event.payload.comment.id = comment_id;
    });

    test.each([
      [`@${CIFlowBot.bot_assignee} ciflow rerun`, ["ciflow/default"]],
      [
        `@${CIFlowBot.bot_assignee} ciflow rerun -l ciflow/scheduled`,
        ["ciflow/default", "ciflow/scheduled"],
      ],
      [
        `@${CIFlowBot.bot_assignee} ciflow rerun -l ciflow/scheduled -l ciflow/slow`,
        ["ciflow/default", "ciflow/scheduled", "ciflow/slow"],
      ],
    ])(
      `valid comment: %s, expected labels: %j`,
      async (validComment: string, expectedLabels: string[]) => {
        event.payload.comment.body = validComment;
        for (const permission of ["write", "admin"]) {
          const scope = nock("https://api.github.com")
            .get(
              `/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`
            )
            .reply(200, { permission: `${permission}` })
            .post(
              `/repos/${owner}/${repo}/issues/${pr_number}/labels`,
              (body) => {
                expect(body).toMatchObject({ labels: expectedLabels });
                return true;
              }
            )
            .reply(200)
            .post(
              `/repos/${owner}/${repo}/issues/${pr_number}/assignees`,
              (body) => {
                expect(body).toMatchObject({
                  assignees: [CIFlowBot.bot_assignee],
                });
                return true;
              }
            )
            .reply(200)
            .delete(
              `/repos/${owner}/${repo}/issues/${pr_number}/assignees`,
              (body) => {
                expect(body).toMatchObject({
                  assignees: [CIFlowBot.bot_assignee],
                });
                return true;
              }
            )
            .reply(200)
            .post(
              `/repos/${owner}/${repo}/issues/comments/${comment_id}/reactions`,
              (body) => {
                expect(body).toMatchObject({ content: "+1" });
                return true;
              }
            )
            .reply(200);

          await p.receive(event);

          if (!scope.isDone()) {
            console.error("pending mocks: %j", scope.pendingMocks());
          }
          scope.done();
        }
      }
    );
  });

  describe("issue_comment.created event: add_default_labels strategy with invalid parseComments", () => {
    const event = require("./fixtures/issue_comment.json");

    beforeEach(() => {
      event.payload.issue.number = pr_number;
      event.payload.repository.owner.login = owner;
      event.payload.repository.name = repo;
      event.payload.comment.user.login = "non-exist-user";
    });

    test.each([
      `invalid`,
      `@${CIFlowBot.bot_assignee} invalid`,
      `@${CIFlowBot.bot_assignee} ciflow invalid`,
    ])(`invalid comment: %s`, async (invalidComment: string) => {
      event.payload.comment.body = invalidComment;

      // we shouldn't hit the github API, thus a catch-all scope and asserting no api calls
      const scope = nock("https://api.github.com");

      await p.receive(event);
      if (!scope.isDone()) {
        console.error("pending mocks: %j", scope.pendingMocks());
      }
      scope.done();
    });
  });

  test("issue_comment.created event: add_default_labels strategy not not enough permission", async () => {
    const event = require("./fixtures/issue_comment.json");
    event.payload.issue.number = pr_number;
    event.payload.repository.owner.login = owner;
    event.payload.repository.name = repo;
    event.payload.comment.body = `@${CIFlowBot.bot_assignee} ciflow rerun`;
    event.payload.comment.user.login = "non-exist-user";

    for (const permission of ["read", "none"]) {
      const scope = nock("https://api.github.com")
        .get(
          `/repos/${owner}/${repo}/collaborators/${event.payload.comment.user.login}/permission`
        )
        .reply(200, { permission: `${permission}` });
      await p.receive(event);

      if (!scope.isDone()) {
        console.error("pending mocks: %j", scope.pendingMocks());
      }
      scope.done();
    }
  });
});

describe("Ruleset Integration Tests", () => {
  const pr_number = 5;
  const owner = "ezyang";
  const repo = "testing-ideal-computing-machine";
  const comment_id = 10;
  const comment_node_id = "abcd";
  const sha = "6f0d678512460e8a1e797d31928b97b5e6244088";

  const event = require("./fixtures/issue_comment.json");
  event.payload.issue.number = pr_number;
  event.payload.repository.owner.login = owner;
  event.payload.repository.name = repo;
  event.payload.comment.user.login = event.payload.issue.user.login;
  const github = new probot.ProbotOctokit();

  beforeEach(() => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
    nockTracker("@octocat ciflow/none", "pytorch/pytorch");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("Upsert ruleset to the root comment block: create new comment when not found", async () => {
    // @ts-ignore
    const ctx = new probot.Context(event, github, null);
    const ruleset = new Ruleset(ctx, owner, repo, pr_number, [
      "ciflow/default",
    ]);

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}`)
      .reply(200, {
        head: {
          sha: sha,
          repo: {
            name: repo,
            owner: {
              login: owner,
            },
          },
        },
      })
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/generated-ciflow-ruleset.json"
        )}?ref=${sha}`
      )
      .reply(200, {
        content: Buffer.from(
          JSON.stringify({
            version: "v1",
            label_rules: {
              "ciflow/default": ["sample_ci.yml"],
            },
          })
        ).toString("base64"),
      })
      .get(`/repos/${owner}/${repo}/issues/${pr_number}/comments?per_page=10`)
      .reply(200, [])
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain("<!-- ciflow-comment-start -->");
        expect(JSON.stringify(body)).toContain("<!-- ciflow-comment-end -->");
        return true;
      })
      .reply(200, {});
    await ruleset.upsertRootComment();

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("Upsert ruleset to the root comment block: update existing comment when found", async () => {
    // @ts-ignore
    const ctx = new probot.Context(event, github, null);
    const ruleset = new Ruleset(ctx, owner, repo, pr_number, [
      "ciflow/default",
    ]);

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/pulls/${pr_number}`)
      .reply(200, {
        head: {
          sha: sha,
          repo: {
            name: repo,
            owner: {
              login: owner,
            },
          },
        },
      })
      .get(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(
          ".github/generated-ciflow-ruleset.json"
        )}?ref=${sha}`
      )
      .reply(200, {
        content: Buffer.from(
          JSON.stringify({
            version: "v1",
            label_rules: {
              "ciflow/default": ["sample_ci.yml"],
            },
          })
        ).toString("base64"),
      })
      .get(`/repos/${owner}/${repo}/issues/${pr_number}/comments?per_page=10`)
      .reply(200, [
        {
          id: comment_id,
          node_id: comment_node_id,
          body: "<!-- ciflow-comment-start -->\nshould_be_removed\n<!-- ciflow-comment-end -->\nshould_not_be_removed \n",
        },
      ])
      .patch(
        `/repos/${owner}/${repo}/issues/comments/${comment_id}`,
        (body) => {
          expect(JSON.stringify(body)).toContain("<!-- ciflow-comment-end -->");
          expect(JSON.stringify(body)).toContain(":white_check_mark:");
          expect(JSON.stringify(body)).toContain("should_not_be_removed");
          expect(JSON.stringify(body)).not.toContain("should_be_removed");
          return true;
        }
      )
      .reply(200);
    await ruleset.upsertRootComment();

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });
});
