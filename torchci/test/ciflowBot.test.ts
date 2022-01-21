import nock from "nock";
import * as probot from "probot";
import * as utils from "./utils";
import ciflowBot, { Ruleset } from "../lib/bot/ciflowBot";
import { nockTracker } from "./common";

nock.disableNetConnect();

describe("CIFlowBot Integration Tests", () => {
  let p: probot.Probot;
  const pr_number = 5;
  const owner = "pytorch";
  const repo = "pytorch";

  beforeEach(() => {
    p = utils.testProbot();
    ciflowBot(p);

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
    nock.cleanAll();
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

  describe("issue_comment.created event", () => {
    const event = require("./fixtures/issue_comment.json");

    test("random comment doesn't trigger response", async () => {
      // we shouldn't hit the github API, thus a catch-all scope and asserting no api calls
      const scope = nock("https://api.github.com");

      await p.receive(event);
      if (!scope.isDone()) {
        console.error("pending mocks: %j", scope.pendingMocks());
      }
      scope.done();
    });

    test("ciflowbot related comment elicits a response", async () => {
      const owner = event.payload.repository.owner.login;
      const repo = event.payload.repository.name;
      event.payload.comment.body = "@pytorchbot ciflow do something!";
      // we shouldn't hit the github API, thus a catch-all scope and asserting no api calls
      const scope = nock("https://api.github.com")
        .post(
          `/repos/${owner}/${repo}/issues/${pr_number}/comments`,
          (body) => {
            expect(JSON.stringify(body)).toContain(
              "You don't need to manually issue ciflow"
            );
            return true;
          }
        )
        .reply(200, {});

      await p.receive(event);
      if (!scope.isDone()) {
        console.error("pending mocks: %j", scope.pendingMocks());
      }
      scope.done();
    });
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
    const ruleset = new Ruleset(ctx, pr_number, ["ciflow/default"]);

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
    const ruleset = new Ruleset(ctx, pr_number, ["ciflow/default"]);

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
