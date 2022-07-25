import { Probot } from "probot";
import * as utils from "./utils";
import nock from "nock";
import myProbotApp from "../lib/bot/drciBot";
import * as drciUtils from "lib/drciUtils";

const comment_id = 10;
const comment_node_id = "abcd";

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

  test("Dr. CI comments if user of PR is swang392", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = require("./fixtures/pull_request.opened")["payload"];
    payload["pull_request"]["user"]["login"] = "swang392";
    payload["repository"]["owner"]["login"] = "pytorch";
    payload["repository"]["name"] = "pytorch";

    const scope = nock("https://api.github.com")
      .get(
        "/repos/pytorch/pytorch/issues/31/comments",
        (body) => {
          return true;
        }
      )
      .reply(200)
      .post(
        "/repos/pytorch/pytorch/issues/31/comments",
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

    if (!nock.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
  });

  test("Dr. CI does not comment when user of PR is swang392", async () => {
    const payload = require("./fixtures/pull_request.opened")["payload"];
    payload["pull_request"]["user"]["login"] = "not_swang392";

    const mock = jest.spyOn(drciUtils, "formDrciHeader");
    mock.mockImplementation();

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });
    expect(mock).not.toHaveBeenCalled();
  });

  test("Dr. CI edits existing comment if a comment is already present", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = require("./fixtures/pull_request.opened")["payload"];
    payload["pull_request"]["user"]["login"] = "swang392";
    payload["repository"]["owner"]["login"] = "pytorch";
    payload["repository"]["name"] = "pytorch";

    const scope = nock("https://api.github.com")
      .get(
        "/repos/pytorch/pytorch/issues/31/comments",
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
        `/repos/pytorch/pytorch/issues/comments/${comment_id}`,
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

    if (!nock.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
  });
});
