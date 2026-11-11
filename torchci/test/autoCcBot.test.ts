import * as botUtils from "lib/bot/utils";
import nock from "nock";
import { Probot } from "probot";
import myProbotApp from "../lib/bot/autoCcBot";
import { nockTracker, requireDeepCopy } from "./common";
import * as utils from "./utils";
nock.disableNetConnect();

describe("auto-cc-bot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nock.cleanAll();
  });

  function mockIsPytorchbotSupportedOrg(bool: boolean) {
    return jest
      .spyOn(botUtils, "isPyTorchbotSupportedOrg")
      .mockReturnValue(bool);
  }

  // The bot reads the current body and labels rather than the webhook snapshot
  function nockCurrentIssue(repo: string, number: number, item: any) {
    return nock("https://api.github.com")
      .get(`/repos/${repo}/issues/${number}`)
      .reply(200, { body: item.body, labels: item.labels });
  }

  test("no-op when tracker is missing", async () => {
    nock("https://api.github.com")
      .get(
        `/repos/ezyang/testing-ideal-computing-machine/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(404, { message: "There is nothing here" });

    // Not sure why, but ProBot will look here if config is missing in the actual repo
    nock("https://api.github.com")
      .get(
        `/repos/ezyang/.github/contents/${encodeURIComponent(
          ".github/pytorch-probot.yml"
        )}`
      )
      .reply(404, { message: "There is nothing here" });

    const payload = require("./fixtures/issues.labeled"); // testlabel
    await probot.receive({ name: "issues", payload, id: "2" });
  });

  test("add a cc when issue is labeled(skipping self)", async () => {
    mockIsPytorchbotSupportedOrg(true);
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    nockTracker(`
Some header text

* testlabel @ezyang @malfet
`);

    const payload = require("./fixtures/issues.labeled"); // testlabel
    payload["issue"]["body"] = "Arf arf";

    nockCurrentIssue(
      "ezyang/testing-ideal-computing-machine",
      5,
      payload["issue"]
    );
    const scope = nock("https://api.github.com")
      .patch(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5",
        (body: any) => {
          expect(body).toMatchObject({
            body: "Arf arf\n\ncc @malfet",
          });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload, id: "2" });

    scope.done();
  });
  test("add a cc to issue with empty body", async () => {
    mockIsPytorchbotSupportedOrg(true);
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    nockTracker(`
Some header text

* testlabel @malfet
`);

    const payload = require("./fixtures/issues.labeled"); // testlabel
    payload["issue"]["body"] = null;

    nockCurrentIssue(
      "ezyang/testing-ideal-computing-machine",
      5,
      payload["issue"]
    );
    const scope = nock("https://api.github.com")
      .patch(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5",
        (body: any) => {
          expect(body).toMatchObject({
            body: "cc @malfet",
          });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload, id: "2" });

    scope.done();
  });

  test("add a cc when PR is labeled", async () => {
    mockIsPytorchbotSupportedOrg(true);
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    nockTracker(
      `
Some header text

* ci/windows @ezyang
`,
      "seemethere/test-repo"
    );

    const payload = require("./fixtures/pull_request.labeled");
    payload["pull_request"]["body"] = "Arf arf";

    nockCurrentIssue("seemethere/test-repo", 20, payload["pull_request"]);
    const scope = nock("https://api.github.com")
      .patch("/repos/seemethere/test-repo/pulls/20", (body: any) => {
        expect(body).toMatchObject({
          body: "Arf arf\n\ncc @ezyang",
        });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload, id: "2" });

    scope.done();
  });

  test("update an existing cc when issue is labeled", async () => {
    mockIsPytorchbotSupportedOrg(true);
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    nockTracker(`
Some header text

* testlabel @malfet
`);

    const payload = require("./fixtures/issues.labeled");
    payload["issue"]["body"] = "Arf arf\n\ncc @moo @foo/bar @mar\nxxxx";

    nockCurrentIssue(
      "ezyang/testing-ideal-computing-machine",
      5,
      payload["issue"]
    );
    const scope = nock("https://api.github.com")
      .patch(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5",
        (body: any) => {
          expect(body).toMatchObject({
            body: "Arf arf\n\ncc @malfet @moo @foo/bar @mar\nxxxx",
          });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload, id: "2" });

    scope.done();
  });

  test("mkldnn update bug", async () => {
    mockIsPytorchbotSupportedOrg(true);
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    nockTracker(
      `* module: mkldnn @gujinghui @PenghuiCheng @XiaobingSuper @ezyang`
    );

    const payload = require("./fixtures/issues.labeled");
    payload["issue"][
      "body"
    ] = `its from master branch, seems related with mklml. any idea?

cc @ezyang`;
    payload["issue"]["labels"] = [{ name: "module: mkldnn" }];
    payload["label"] = { name: "module: mkldnn" };

    nockCurrentIssue(
      "ezyang/testing-ideal-computing-machine",
      5,
      payload["issue"]
    );
    const scope = nock("https://api.github.com")
      .patch(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5",
        (body: any) => {
          expect(body).toMatchObject({
            body: `its from master branch, seems related with mklml. any idea?

cc @gujinghui @PenghuiCheng @XiaobingSuper @ezyang`,
          });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload, id: "2" });

    scope.done();
  });
  test("skip update when the cc was already added by another handler", async () => {
    mockIsPytorchbotSupportedOrg(true);
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    nockTracker(`
* testlabel @malfet
`);

    const payload = requireDeepCopy("./fixtures/issues.labeled");
    payload["label"] = { name: "testlabel" };
    // Webhook snapshot predates the edit made while handling a sibling label
    payload["issue"]["body"] = "Arf arf";
    nockCurrentIssue("ezyang/testing-ideal-computing-machine", 5, {
      body: "Arf arf\n\ncc @malfet",
      labels: payload["issue"]["labels"],
    });
    const scope = nock("https://api.github.com")
      .patch("/repos/ezyang/testing-ideal-computing-machine/issues/5")
      .reply(200);

    await probot.receive({ name: "issues", payload, id: "2" });

    expect(scope.isDone()).toBe(false);
  });

  test("cc subscribers of all labels currently on the issue", async () => {
    mockIsPytorchbotSupportedOrg(true);
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    nockTracker(`
* testlabel @malfet
* otherlabel @foo
`);

    const payload = requireDeepCopy("./fixtures/issues.labeled");
    payload["label"] = { name: "testlabel" };
    payload["issue"]["body"] = "Arf arf";
    // Both labels were added at once, so this event's snapshot may not list the other one
    nockCurrentIssue("ezyang/testing-ideal-computing-machine", 5, {
      body: "Arf arf",
      labels: [{ name: "testlabel" }, { name: "otherlabel" }],
    });
    const scope = nock("https://api.github.com")
      .patch(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5",
        (body: any) => {
          expect(body).toMatchObject({ body: "Arf arf\n\ncc @malfet @foo" });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload, id: "2" });

    scope.done();
  });

  test("no-op when added label has no subscribers", async () => {
    mockIsPytorchbotSupportedOrg(true);
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    nockTracker(`
* otherlabel @malfet
`);

    const payload = requireDeepCopy("./fixtures/issues.labeled");
    payload["issue"]["labels"] = [
      { name: "testlabel" },
      { name: "otherlabel" },
    ];
    // Neither the issue nor its body should be fetched or touched
    const scope = nock("https://api.github.com")
      .get("/repos/ezyang/testing-ideal-computing-machine/issues/5")
      .reply(200, {});

    await probot.receive({ name: "issues", payload, id: "2" });

    expect(scope.isDone()).toBe(false);
  });
});

// For more information about testing with Jest see:
// https://facebook.github.io/jest/

// For more information about testing with Nock see:
// https://github.com/nock/nock
