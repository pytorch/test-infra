import nock from "nock";
import { Probot } from "probot";
import myProbotApp, {
  ACCEPT_2_RUN,
  ACCEPT_2_SHIP,
  ACCEPT_MESSAGE_PREFIX,
  CIFLOW_TRUNK_LABEL,
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
    event.payload.review.state = "approved";
    const scope = nock("https://api.github.com");
    await probot.receive(event);

    handleScope(scope);
  });

  test("Add ciflow tag on approval of a accept2run PR", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_review.json");
    event.payload.review.state = "approved";
    event.payload.pull_request.labels = [{ name: ACCEPT_2_RUN }];
    event.payload.repository.name = "pytorch-canary";

    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    const pr_number = event.payload.pull_request.number;

    const scope = nock("https://api.github.com")
      .post(`/repos/${owner}/${repo}/issues/${pr_number}/labels`, (body) => {
        expect(JSON.stringify(body)).toContain(
          `"labels":["${CIFLOW_TRUNK_LABEL}"]`
        );
        return true;
      })
      .reply(200, {})
      .delete(`/repos/${owner}/${repo}/issues/4/labels/${ACCEPT_2_RUN}`)
      .reply(200, {});
    await probot.receive(event);

    handleScope(scope);
  });

  test("Comment on approval of a accept2ship PR", async () => {
    const event = requireDeepCopy("./fixtures/pull_request_review.json");
    event.payload.review.state = "approved";
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
      .reply(200, {})
      .delete(`/repos/${owner}/${repo}/issues/4/labels/${ACCEPT_2_SHIP}`)
      .reply(200, {});
    await probot.receive(event);

    handleScope(scope);
  });

  test("Run when PR is accepted already and then labeled", async () => {
    const payload = requireDeepCopy("./fixtures/pull_request.labeled.json");
    payload.label.name = ACCEPT_2_RUN;

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const pr_number = payload.pull_request.number;
    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/pulls/20/reviews`)
      .reply(200, [{ state: "approved" }])
      .post(`/repos/${owner}/${repo}/issues/20/labels`)
      .reply(200, {})
      .delete(`/repos/${owner}/${repo}/issues/20/labels/${ACCEPT_2_RUN}`)
      .reply(200, {});

    await probot.receive({ name: "pull_request", id: "123", payload });

    handleScope(scope);
  });

  test("Don't run when PR is not accepted and then labeled", async () => {
    const payload = requireDeepCopy("./fixtures/pull_request.labeled.json");
    payload.label.name = ACCEPT_2_RUN;

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const pr_number = payload.pull_request.number;
    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/pulls/20/reviews`)
      .reply(200, []);

    await probot.receive({ name: "pull_request", id: "123", payload });

    handleScope(scope);
  });
});
