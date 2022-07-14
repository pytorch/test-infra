import nock from "nock";
import { Probot } from "probot";
import myProbotApp, {
  ACCEPT_2_RUN,
  ACCEPT_2_SHIP,
  ACCEPT_MESSAGE_PREFIX,
  CIFLOW_ALL,
} from "../lib/bot/acceptBot";
import { handleScope, requireDeepCopy } from "./common";
import * as utils from "./utils";
nock.disableNetConnect();

describe("accept bot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
  });

  test("Do nothing on approval of a non labeled PR", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_review.json");
    event.payload.review.state = "APPROVED";
    const scope = nock("https://api.github.com");
    await probot.receive(event);

    handleScope(scope);
  });

  test("Add ciflow tag on approval of a accept2run PR", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_review.json");
    event.payload.review.state = "APPROVED";
    event.payload.pull_request.labels = [{ name: ACCEPT_2_RUN }];
    event.payload.repository.name = "pytorch-canary";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.pull_request.number;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/labels`, (body) => {
        expect(JSON.stringify(body)).toContain(`"labels":["${CIFLOW_ALL}"]`);
        return true;
      })

      .reply(200, {});
    await probot.receive(event);

    handleScope(scope);
  });

  test("Comment on approval of a accept2ship PR", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_review.json");
    event.payload.review.state = "APPROVED";
    event.payload.pull_request.labels = [{ name: ACCEPT_2_SHIP }];
    event.payload.repository.name = "pytorch-canary";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.pull_request.number;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `"body":"${ACCEPT_MESSAGE_PREFIX}`
        );
        return true;
      })

      .reply(200, {});
    await probot.receive(event);

    handleScope(scope);
  });
});
