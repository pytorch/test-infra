import nock from "nock";
import * as utils from "./utils";
import myProbotApp from "../lib/bot/codevNoWritePermBot";
import { handleScope, requireDeepCopy } from "./common";
import { Probot } from "probot";
import * as botUtils from "lib/bot/utils";

nock.disableNetConnect();

describe("codevNoWritePermBot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nock.cleanAll();
  });

  function mockIsPytorchPytorch(bool: boolean) {
    return jest.spyOn(botUtils, "isPyTorchPyTorch").mockReturnValue(bool);
  }

  test("ignore non pytorch/pytorch PR", async () => {
    const payload = requireDeepCopy("./fixtures/pull_request.opened");
    payload.payload.pull_request.body = "Differential Revision: D123123123";
    mockIsPytorchPytorch(false);
    await probot.receive(payload);
  });

  test("ignore pytorch/pytorch PR that is not codev", async () => {
    const payload = requireDeepCopy("./fixtures/pull_request.opened");
    mockIsPytorchPytorch(true);
    payload.payload.pull_request.body = "This is not a codev PR";
    await probot.receive(payload);
  });

  test("do not comment if has write perms", async () => {
    const payload = requireDeepCopy("./fixtures/pull_request.opened");
    payload.payload.pull_request.body = "Differential Revision: D123123123";
    const repoFullName = payload.payload.repository.full_name;
    const author = payload.payload.pull_request.user.login;
    mockIsPytorchPytorch(true);
    const scope = utils.mockPermissions(repoFullName, author, "write");
    await probot.receive(payload);
    handleScope(scope);
  });

  test("comment if no write perms", async () => {
    const payload = requireDeepCopy("./fixtures/pull_request.opened");
    payload.payload.pull_request.body = "Differential Revision: D123123123";
    const repoFullName = payload.payload.repository.full_name;
    const author = payload.payload.pull_request.user.login;
    mockIsPytorchPytorch(true);
    const scopes = [
      utils.mockPermissions(repoFullName, author, "read"),
      utils.mockPostComment(repoFullName, 31, [
        `Hi there, this appears to be a diff that was exported from phabricator`,
      ]),
    ];
    await probot.receive(payload);
    handleScope(scopes);
  });
});
