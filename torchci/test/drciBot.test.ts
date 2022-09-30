import _ from "lodash";
import { Probot } from "probot";
import * as utils from "./utils";
import nock from "nock";
import myProbotApp from "../lib/bot/drciBot";
import * as drciUtils from "lib/drciUtils";
import { OWNER, REPO } from "lib/drciUtils";
import { handleScope } from "./common";

nock.disableNetConnect();

const comment_id = 10;
const comment_node_id = "abcd";
const some_user = "github_user"

describe("verify-drci-functionality", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
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
      .get(
        `/repos/${OWNER}/${REPO}/issues/31/comments`,
        (body) => {
          return true;
        }
      )
      .reply(200)
      .post(
        `/repos/${OWNER}/${REPO}/issues/31/comments`,
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
      .get(
        `/repos/${OWNER}/${REPO}/issues/31/comments`,
        (body) => {
          return true;
        }
      )
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
});
