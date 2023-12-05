import nock from "nock";
import { Probot } from "probot";
import myProbotApp, { CIFLOW_TRUNK_LABEL } from "../lib/bot/acceptBot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";
nock.disableNetConnect();

describe("strip approvals bot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
  });

  test("Do nothing on normal contributor", async () => {
    const event = requireDeepCopy("./fixtures/pull_request.reopened.json");
    const scope = nock("https://api.github.com");
    await probot.receive(event);

    handleScope(scope);
  });
});
