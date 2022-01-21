import nock from "nock";
import * as utils from "./utils";
import myProbotApp from "../lib/bot/autoCcBot";
import { nockTracker } from "./common";
import { Probot } from "probot";

nock.disableNetConnect();

describe("auto-cc-bot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
  });

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

  test("add a cc when issue is labeled", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    nockTracker(`
Some header text

* testlabel @ezyang
`);

    const payload = require("./fixtures/issues.labeled"); // testlabel
    payload["issue"]["body"] = "Arf arf";

    const scope = nock("https://api.github.com")
      .patch(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5",
        (body: any) => {
          expect(body).toMatchObject({
            body: "Arf arf\n\ncc @ezyang",
          });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload, id: "2" });

    scope.done();
  });
  test("add a cc to issue with empty body", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    nockTracker(`
Some header text

* testlabel @ezyang
`);

    const payload = require("./fixtures/issues.labeled"); // testlabel
    payload["issue"]["body"] = null;

    const scope = nock("https://api.github.com")
      .patch(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5",
        (body: any) => {
          expect(body).toMatchObject({
            body: "cc @ezyang",
          });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload, id: "2" });

    scope.done();
  });

  test("add a cc when PR is labeled", async () => {
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

    const scope = nock("https://api.github.com")
      .patch("/repos/seemethere/test-repo/pulls/", (body: any) => {
        expect(body).toMatchObject({
          issue_number: 20,
          body: "Arf arf\n\ncc @ezyang",
        });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload, id: "2" });

    scope.done();
  });

  test("update an existing cc when issue is labeled", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    nockTracker(`
Some header text

* testlabel @ezyang
`);

    const payload = require("./fixtures/issues.labeled");
    payload["issue"]["body"] = "Arf arf\n\ncc @moo @foo/bar @mar\nxxxx";

    const scope = nock("https://api.github.com")
      .patch(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5",
        (body: any) => {
          expect(body).toMatchObject({
            body: "Arf arf\n\ncc @ezyang @moo @foo/bar @mar\nxxxx",
          });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload, id: "2" });

    scope.done();
  });

  test("mkldnn update bug", async () => {
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
});

// For more information about testing with Jest see:
// https://facebook.github.io/jest/

// For more information about testing with Nock see:
// https://github.com/nock/nock
