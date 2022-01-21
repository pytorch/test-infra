import nock from "nock";
import { Probot } from "probot";
import * as utils from "./utils";
import myProbotApp from "../lib/bot/autoLabelBot";

nock.disableNetConnect();

describe("auto-label-bot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
  });

  test("add triage review when issue is labeled high priority", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = require("./fixtures/issues.labeled");
    payload["label"] = { name: "high priority" };
    payload["issue"]["labels"] = [{ name: "high priority" }];

    const scope = nock("https://api.github.com")
      .post(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5/labels",
        (body) => {
          expect(body).toMatchObject({ labels: ["triage review"] });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload, id: "2" });

    scope.done();
  });

  test("add rocm label when issue title contains ROCm", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = require("./fixtures/issues.opened");
    payload["issue"]["title"] = "Issue regarding ROCm";
    payload["issue"]["labels"] = [];

    const scope = nock("https://api.github.com")
      .post(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5/labels",
        (body) => {
          expect(body).toMatchObject({ labels: ["module: rocm"] });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload: payload, id: "2" });

    scope.done();
  });

  test("add rocm label when PR title contains ROCm", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = require("./fixtures/pull_request.opened")["payload"];
    payload["pull_request"]["title"] = "Issue regarding ROCm";
    payload["pull_request"]["labels"] = [];

    const scope = nock("https://api.github.com")
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["module: rocm"] });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });

  test("add skipped label when issue title contains DISABLED test", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = require("./fixtures/issues.opened");
    payload["issue"]["title"] = "DISABLED  test_blah (__main__.TestClass)";
    payload["issue"]["labels"] = [];

    const scope = nock("https://api.github.com")
      .post(
        "/repos/ezyang/testing-ideal-computing-machine/issues/5/labels",
        (body) => {
          expect(body).toMatchObject({ labels: ["skipped"] });
          return true;
        }
      )
      .reply(200);

    await probot.receive({ name: "issues", payload: payload, id: "2" });

    scope.done();
  });

  test("add skipped label when PR title contains DISABLED test", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const payload = require("./fixtures/pull_request.opened")["payload"];
    payload["pull_request"]["title"] =
      "DISABLED test_blah (__main__.TestClass)";
    payload["pull_request"]["labels"] = [];

    const scope = nock("https://api.github.com")
      .post("/repos/zhouzhuojie/gha-ci-playground/issues/31/labels", (body) => {
        expect(body).toMatchObject({ labels: ["skipped"] });
        return true;
      })
      .reply(200);

    await probot.receive({ name: "pull_request", payload: payload, id: "2" });

    scope.done();
  });
});
