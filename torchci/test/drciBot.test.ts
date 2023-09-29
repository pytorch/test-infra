import _ from "lodash";
import { Probot } from "probot";
import * as utils from "./utils";
import nock from "nock";
import myProbotApp from "../lib/bot/drciBot";
import pytorchBot from "../lib/bot/pytorchBot";
import * as drciUtils from "lib/drciUtils";
import { OWNER, REPO } from "lib/drciUtils";
import { handleScope } from "./common";
import { successfulA } from "./drci.test";

nock.disableNetConnect();

const comment_id = 10;
const comment_node_id = "abcd";
const some_user = "github_user";

describe("verify-drci-functionality", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
    nock("https://raw.githubusercontent.com")
      .get((url) => url.includes("rules.json"))
      .reply(200, []);
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("Dr. CI comments on any user's PR", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = require("./fixtures/pull_request.opened")["payload"];
    payload["pull_request"]["user"]["login"] = some_user;
    payload["repository"]["owner"]["login"] = OWNER;
    payload["repository"]["name"] = REPO;

    process.env.ROCKSET_API_KEY = "random key doesnt matter";
    const rockset = nock("https://api.rs2.usw2.rockset.com")
      .post((uri) => true)
      .reply(200, { results: [] });
    const scope = nock("https://api.github.com")
      .get(`/repos/${OWNER}/${REPO}/issues/31/comments`, (body) => {
        return true;
      })
      .reply(200)
      .post(`/repos/${OWNER}/${REPO}/issues/31/comments`, (body) => {
        const comment = body.body;
        expect(comment.includes(drciUtils.DRCI_COMMENT_START)).toBeTruthy();
        expect(
          comment.includes("See artifacts and rendered test results")
        ).toBeTruthy();
        expect(
          comment.includes("Need help or want to give feedback on the CI?")
        ).toBeTruthy();
        expect(comment.includes(drciUtils.OH_URL)).toBeTruthy();
        expect(comment.includes(drciUtils.DOCS_URL)).toBeTruthy();
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });
    handleScope(scope);
    handleScope(rockset);
  });

  test("Dr. CI edits existing comment if a comment is already present", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = require("./fixtures/pull_request.opened")["payload"];
    payload["pull_request"]["user"]["login"] = some_user;
    payload["repository"]["owner"]["login"] = OWNER;
    payload["repository"]["name"] = REPO;

    process.env.ROCKSET_API_KEY = "random key doesnt matter";
    const rockset = nock("https://api.rs2.usw2.rockset.com")
      .post((uri) => true)
      .reply(200, { results: [] });
    const scope = nock("https://api.github.com")
      .get(`/repos/${OWNER}/${REPO}/issues/31/comments`, (body) => {
        return true;
      })
      .reply(200, [
        {
          id: comment_id,
          node_id: comment_node_id,
          body: "<!-- drci-comment-start -->\nhello\n<!-- drci-comment-end -->\n",
        },
      ])
      .patch(
        `/repos/${OWNER}/${REPO}/issues/comments/${comment_id}`,
        (body) => {
          const comment = body.body;
          expect(comment.includes(drciUtils.DRCI_COMMENT_START)).toBeTruthy();
          expect(
            comment.includes("See artifacts and rendered test results")
          ).toBeTruthy();
          expect(
            comment.includes("Need help or want to give feedback on the CI?")
          ).toBeTruthy();
          expect(comment.includes(drciUtils.OH_URL)).toBeTruthy();
          expect(comment.includes(drciUtils.DOCS_URL)).toBeTruthy();
          return true;
        }
      )
      .reply(200);
    await probot.receive({ name: "pull_request", payload: payload, id: "2" });
    handleScope(scope);
    handleScope(rockset);
  });

  test("Dr. CI does not comment when the PR is not open", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = require("./fixtures/pull_request.opened")["payload"];
    payload["pull_request"]["user"]["login"] = some_user;
    payload["pull_request"]["state"] = "closed";
    payload["repository"]["owner"]["login"] = OWNER;
    payload["repository"]["name"] = REPO;

    const mock = jest.spyOn(drciUtils, "formDrciHeader");
    mock.mockImplementation();

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });
    expect(mock).not.toHaveBeenCalled();
  });

  test("Dr. CI does not comment when the repo is not PyTorch", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = require("./fixtures/pull_request.opened")["payload"];
    payload["pull_request"]["user"]["login"] = some_user;
    payload["repository"]["owner"]["login"] = OWNER;
    payload["repository"]["name"] = "torchdynamo";

    const mock = jest.spyOn(drciUtils, "formDrciHeader");
    mock.mockImplementation();

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });
    expect(mock).not.toHaveBeenCalled();
  });

  test("Dr. CI edits existing comment if an explicit update request is made", async () => {
    probot = utils.testProbot();
    probot.load(pytorchBot);

    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const event = require("./fixtures/pull_request_comment");
    event["payload"]["repository"]["owner"]["login"] = OWNER;
    event["payload"]["repository"]["name"] = REPO;
    event["payload"]["comment"]["body"] = "@pytorchmergebot drci";
    const pytorchbot_comment_number = event["payload"]["comment"]["id"];

    process.env.ROCKSET_API_KEY = "random key doesnt matter";
    const rockset = nock("https://api.rs2.usw2.rockset.com")
      .post((uri) => uri.includes("recent_pr_workflows_query"))
      .reply(200, { results: [successfulA] })
      .post((uri) => uri.includes("issue_query"))
      .reply(200, { results: [] })
      .post((url) => url.includes("commit_failed_jobs"))
      .reply(200, { results: [] })
      .post(
        (url) => url.includes("self/queries"),
        (body) => JSON.stringify(body).includes("merge_base_commit_date")
      )
      .reply(200, { results: [] }) // query to get merge bases
      .post((url) => url.includes("merge_bases"))
      .reply(200, { results: [] }) // query to insert back to rockset
      .post(
        (url) => url.includes("self/queries"),
        (body) => JSON.stringify(body).includes("issue_comment")
      )
      .reply(200, { results: [] }); // query to get issue comments

    const scope = nock("https://api.github.com")
      .post(
        `/repos/${OWNER}/${REPO}/issues/comments/${pytorchbot_comment_number}/reactions`,
        (body) => {
          expect(JSON.stringify(body)).toContain('{"content":"+1"}');
          return true;
        }
      )
      .reply(200, {})
      .get((url) => url.includes(`/repos/${OWNER}/${REPO}/compare/`))
      .reply(200, {
        merge_base_commit: {
          sha: "dummyMergeBaseSha",
          commit: {
            committer: {
              date: "2023-08-08T06:03:21Z",
            },
          },
        },
      })
      .get(`/repos/${OWNER}/${REPO}/issues/1000/comments`)
      .reply(200, [
        {
          id: comment_id,
          node_id: comment_node_id,
          body: "<!-- drci-comment-start -->\nhello\n<!-- drci-comment-end -->\n",
        },
      ])
      .patch(
        `/repos/${OWNER}/${REPO}/issues/comments/${comment_id}`,
        (body) => {
          const comment = body.body;
          expect(comment.includes(drciUtils.DRCI_COMMENT_START)).toBeTruthy();
          expect(
            comment.includes("See artifacts and rendered test results")
          ).toBeTruthy();
          expect(
            comment.includes("Need help or want to give feedback on the CI?")
          ).toBeTruthy();
          expect(comment.includes(drciUtils.OH_URL)).toBeTruthy();
          expect(comment.includes(drciUtils.DOCS_URL)).toBeTruthy();
          return true;
        }
      )
      .reply(200);
    await probot.receive(event);
    handleScope(scope);
    handleScope(rockset);
  });
});
