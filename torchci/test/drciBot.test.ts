import { Probot } from "probot";
import * as utils from "./utils";
import nock from "nock";
import myProbotApp, * as botUtils from "../lib/bot/drciBot";

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
  
  test("Dr. CI comment if user of PR is swang392", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = require("./fixtures/pull_request.opened")["payload"];
    payload["pull_request"]["user"]["login"] = "swang392"

    const scope = nock("https://api.github.com")
      .get("/repos/zhouzhuojie/gha-ci-playground/issues/31/comments", (body) => {
        return true;
      })
      .reply(200)
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/comments", (body) => {
        const comment = body.body;
        expect(comment.includes(botUtils.drciCommentStart)).toBeTruthy();
        expect(comment.includes("See artifacts and rendered test results")).toBeTruthy();
        expect(comment.includes("Need help or want to give feedback on the CI?")).toBeTruthy();
        expect(comment.includes(botUtils.officeHoursUrl)).toBeTruthy();
        expect(comment.includes(botUtils.docsBuildsUrl)).toBeTruthy();
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    if (!nock.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
  });

  test("Dr. CI does not comment when user of PR is swang392", async () => {
    const payload = require("./fixtures/pull_request.opened")["payload"];
    payload["pull_request"]["user"]["login"] = "not_swang392"

    const mock = jest.spyOn(botUtils, 'formDrciComment')
    mock.mockImplementation();

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });
    expect(mock).not.toHaveBeenCalled();
  });

});