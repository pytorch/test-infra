import { Probot } from "probot";
import * as utils from "./utils";
import myProbotApp, * as bot from "../lib/bot/verifyDisableTestIssueBot";
import nock from "nock";
import { requireDeepCopy, handleScope } from "./common";
import {
  pytorchBotId,
  disabledKey,
  unstableKey,
} from "../lib/bot/verifyDisableTestIssueBot";
import _ from "lodash";

nock.disableNetConnect();

describe("verify-disable-test-issue", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
  });

  test("issue opened with title starts w/ DISABLED: unauthorized", async () => {
    let title = "DISABLED pull / linux-bionic-py3.8-clang9";
    const jobName = bot.parseTitle(title, disabledKey);
    let comment = bot.formJobValidationComment(
      "mock-user",
      false,
      jobName,
      disabledKey
    );

    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(
      comment.includes("You (mock-user) don't have permission to disable")
    ).toBeTruthy();
    expect(comment.includes("ERROR")).toBeTruthy();

    title = "DISABLED testMethodName (testClass.TestSuite)";
    const body = "Platforms:linux,macos";

    const platforms = bot.parseBody(body);
    const testName = bot.parseTitle(title, disabledKey);

    comment = bot.formValidationComment(
      "mock-user",
      false,
      testName,
      platforms
    );

    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(
      comment.includes("You (mock-user) don't have permission to disable")
    ).toBeTruthy();
    expect(comment.includes("ERROR")).toBeTruthy();
  });

  test("issue opened with title starts w/ DISABLED: disable for win", async () => {
    const title = "DISABLED testMethodName (testClass.TestSuite)";
    const body = "whatever\nPlatforms:win\nyay";

    const platforms = bot.parseBody(body);
    const testName = bot.parseTitle(title, disabledKey);
    expect(platforms).toMatchObject([new Set(["win"]), new Set()]);
    expect(testName).toEqual("testMethodName (testClass.TestSuite)");

    const comment = bot.formValidationComment(
      "mock-user",
      true,
      testName,
      platforms
    );
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(
      comment.includes(
        "~15 minutes, `testMethodName (testClass.TestSuite)` will be disabled"
      )
    ).toBeTruthy();
    expect(comment.includes("these platforms: win.")).toBeTruthy();
    expect(comment.includes("ERROR")).toBeFalsy();
    expect(comment.includes("WARNING")).toBeFalsy();
  });

  test("issue opened with title starts w/ DISABLED: disable for windows, rocm, asan", async () => {
    const title = "DISABLED testMethodName (testClass.TestSuite)";
    const body = "whatever\nPlatforms:windows, ROCm, ASAN\nyay";

    const platforms = bot.parseBody(body);
    const testName = bot.parseTitle(title, disabledKey);
    expect(platforms).toMatchObject([
      new Set(["windows", "rocm", "asan"]),
      new Set(),
    ]);
    expect(testName).toEqual("testMethodName (testClass.TestSuite)");

    const comment = bot.formValidationComment(
      "mock-user",
      true,
      testName,
      platforms
    );
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(
      comment.includes(
        "~15 minutes, `testMethodName (testClass.TestSuite)` will be disabled"
      )
    ).toBeTruthy();
    expect(
      comment.includes("these platforms: asan, rocm, windows.")
    ).toBeTruthy();
    expect(comment.includes("ERROR")).toBeFalsy();
    expect(comment.includes("WARNING")).toBeFalsy();
  });

  test("issue opened with title starts w/ DISABLED: disable for all", async () => {
    const title = "DISABLED testMethodName (testClass.TestSuite)";
    const body = "whatever yay";

    const platforms = bot.parseBody(body);
    const testName = bot.parseTitle(title, disabledKey);
    expect(platforms).toMatchObject([new Set(), new Set()]);
    expect(testName).toEqual("testMethodName (testClass.TestSuite)");

    const comment = bot.formValidationComment(
      "mock-user",
      true,
      testName,
      platforms
    );
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(
      comment.includes(
        "~15 minutes, `testMethodName (testClass.TestSuite)` will be disabled"
      )
    ).toBeTruthy();
    expect(comment.includes("all platforms.")).toBeTruthy();
    expect(comment.includes("ERROR")).toBeFalsy();
    expect(comment.includes("WARNING")).toBeFalsy();
  });

  test("issue opened with title starts w/ DISABLED: disable unknown platform", async () => {
    const title = "DISABLED testMethodName (testClass.TestSuite)";
    const body = "whatever\nPlatforms:everything\nyay";

    const platforms = bot.parseBody(body);
    const testName = bot.parseTitle(title, disabledKey);
    expect(platforms).toMatchObject([new Set(), new Set(["everything"])]);
    expect(testName).toEqual("testMethodName (testClass.TestSuite)");

    const comment = bot.formValidationComment(
      "mock-user",
      true,
      testName,
      platforms
    );
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(
      comment.includes(
        "~15 minutes, `testMethodName (testClass.TestSuite)` will be disabled"
      )
    ).toBeTruthy();
    expect(comment.includes("all platforms.")).toBeTruthy();
    expect(comment.includes("ERROR")).toBeFalsy();
    expect(comment.includes("WARNING")).toBeTruthy();
    expect(
      comment.includes(
        "invalid inputs as platforms for which the test will be disabled: everything."
      )
    ).toBeTruthy();
  });

  test("issue opened with title starts w/ DISABLED: can parse nested test suites", async () => {
    const title =
      "DISABLED testMethodName   (quantization.core.test_workflow_ops.TestFakeQuantizeOps)";
    const body = "whatever\nPlatforms:\nyay";

    const platforms = bot.parseBody(body);
    const testName = bot.parseTitle(title, disabledKey);
    expect(platforms).toMatchObject([new Set(), new Set()]);
    expect(testName).toEqual(
      "testMethodName   (quantization.core.test_workflow_ops.TestFakeQuantizeOps)"
    );

    const comment = bot.formValidationComment(
      "mock-user",
      true,
      testName,
      platforms
    );
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(comment.includes("~15 minutes")).toBeTruthy();
    expect(comment.includes("ERROR")).toBeFalsy();
    expect(comment.includes("WARNING")).toBeFalsy();
  });

  test("issue opened with title starts w/ DISABLED: cannot parse test", async () => {
    const title = "DISABLED testMethodName   cuz it borked  ";
    const body = "whatever\nPlatforms:\nyay";

    const platforms = bot.parseBody(body);
    const testName = bot.parseTitle(title, disabledKey);
    expect(platforms).toMatchObject([new Set(), new Set()]);
    expect(testName).toEqual("testMethodName   cuz it borked");

    const comment = bot.formValidationComment(
      "mock-user",
      true,
      testName,
      platforms
    );
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(comment.includes("~15 minutes")).toBeFalsy();
    expect(comment.includes("ERROR")).toBeTruthy();
    expect(comment.includes("WARNING")).toBeFalsy();
  });

  test("issue opened with title starts w/ DISABLED: cannot parse test nor platforms", async () => {
    const title = "DISABLED testMethodName   cuz it borked  ";
    const body = "whatever\nPlatforms:all of them\nyay";

    const platforms = bot.parseBody(body);
    const testName = bot.parseTitle(title, disabledKey);
    expect(platforms).toMatchObject([new Set(), new Set(["all of them"])]);
    expect(testName).toEqual("testMethodName   cuz it borked");

    const comment = bot.formValidationComment(
      "mock-user",
      true,
      testName,
      platforms
    );
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(comment.includes("~15 minutes")).toBeFalsy();
    expect(comment.includes("ERROR")).toBeTruthy();
    expect(comment.includes("WARNING")).toBeTruthy();
  });

  test("issue opened with title starts w/ DISABLED: check what is disabled", async () => {
    const cases = [
      {
        title:
          "DISABLED test_refinement_through_graph_stitching (jit.test_symbolic_shape_analysis.TestSymbolicShapeAnalysis)",
        expected: true,
      },
      {
        title: "DISABLED test_to_non_blocking (__main__.TestCuda)",
        expected: true,
      },
      {
        title: "DISABLED testMethodName (testClass.TestSuite)",
        expected: true,
      },
      {
        title: "DISABLED pull / linux-bionic-py3.8-clang9 / test (dynamo)",
        expected: false,
      },
      {
        title: "DISABLED pull / linux-bionic-py3.8-clang9 / build",
        expected: false,
      },
      {
        title: "DISABLED pull / linux-bionic-py3.8-clang9",
        expected: false,
      },
    ];

    cases.forEach((item) => {
      const title = item["title"];
      expect(bot.isDisabledTest(title)).toEqual(item["expected"]);
    });
  });

  test("issue opened with title starts w/ DISABLED: to disable a job", async () => {
    const title = "DISABLED pull / linux-bionic-py3.8-clang9";

    const jobName = bot.parseTitle(title, disabledKey);
    expect(jobName).toEqual("pull / linux-bionic-py3.8-clang9");

    let comment = bot.formJobValidationComment(
      "mock-user",
      true,
      jobName,
      disabledKey
    );
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(comment.includes(`~15 minutes, \`${jobName}\``)).toBeTruthy();
    expect(comment.includes("ERROR")).toBeFalsy();
  });

  test("issue opened with title starts w/ UNSTABLE: to mark a job as unstable", async () => {
    const title = "UNSTABLE windows-binary-libtorch-release";

    const jobName = bot.parseTitle(title, unstableKey);
    expect(jobName).toEqual("windows-binary-libtorch-release");

    let comment = bot.formJobValidationComment(
      "mock-user",
      true,
      jobName,
      unstableKey
    );
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(comment.includes(`~15 minutes, \`${jobName}\``)).toBeTruthy();
    expect(comment.includes("ERROR")).toBeFalsy();
  });

  test("various getExpectedLabels tests", async () => {
    expect(await bot.getExpectedLabels(["linux"], ["random"])).toEqual([
      "random",
    ]);
    expect(await bot.getExpectedLabels(["inductor"], ["random"])).toEqual([
      "random",
      "oncall: pt2",
    ]);
    expect(
      await bot.getExpectedLabels(["linux"], ["random", "module: rocm"])
    ).toEqual(["random"]);
    expect(
      await bot.getExpectedLabels(["rocm"], ["random", "module: rocm"])
    ).toEqual(["random", "module: rocm"]);
    expect(
      await bot.getExpectedLabels(
        ["dynamo", "inductor"],
        ["random", "module: rocm"]
      )
    ).toEqual(["random", "oncall: pt2"]);
    expect(
      await bot.getExpectedLabels(["linux", "rocm"], ["random", "module: rocm"])
    ).toEqual(["random"]);
  });
});

describe("verify-disable-test-issue-bot", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("pytorch-bot[bot] is authorized", async () => {
    const payload = requireDeepCopy("./fixtures/issues.opened.json");
    payload.issue.title = "DISABLED testMethodName (testClass.TestSuite)";
    payload.issue.user.id = pytorchBotId;

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const number = payload.issue.number;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=10`)
      .reply(200, [])
      .post(
        `/repos/${owner}/${repo}/issues/${number}/comments`,
        (body) => !body.body.includes("don't have permission")
      )
      .reply(200);

    await probot.receive({ name: "issues", payload: payload, id: "2" });

    handleScope(scope);
  });

  test("random user is not authorized", async () => {
    const payload = requireDeepCopy("./fixtures/issues.opened.json");
    payload.issue.title = "DISABLED testMethodName (testClass.TestSuite)";
    payload.issue.user.login = "randomuser";

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const number = payload.issue.number;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=10`)
      .reply(200, [])
      .get(`/repos/${owner}/${repo}/collaborators/randomuser/permission`)
      .reply(200, {
        permission: "read",
      })
      .post(`/repos/${owner}/${repo}/issues/${number}/comments`, (body) =>
        body.body.includes("don't have permission")
      )
      .reply(200)
      .patch(
        `/repos/${owner}/${repo}/issues/${number}`,
        (body) => body.state === "closed"
      )
      .reply(200);

    await probot.receive({ name: "issues", payload: payload, id: "2" });

    handleScope(scope);
  });

  test("issue with missing labels gets labels", async () => {
    const payload = requireDeepCopy("./fixtures/issues.opened.json");
    payload.issue.title = "DISABLED testMethodName (testClass.TestSuite)";
    payload.issue.user.id = pytorchBotId;
    payload.issue.body = "Platforms: rocm";

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const number = payload.issue.number;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=10`)
      .reply(200, [])
      .post(
        `/repos/${owner}/${repo}/issues/${number}/comments`,
        (body) => !body.body.includes("don't have permission")
      )
      .reply(200)
      .put(`/repos/${owner}/${repo}/issues/${number}/labels`, (body) =>
        _.isEqual(body.labels, ["module: rocm"])
      )
      .reply(200, []);

    await probot.receive({ name: "issues", payload: payload, id: "2" });

    handleScope(scope);
  });

  test("issue with wrong labels gets correct labels", async () => {
    const payload = requireDeepCopy("./fixtures/issues.opened.json");
    payload.issue.title = "DISABLED testMethodName (testClass.TestSuite)";
    payload.issue.user.id = pytorchBotId;
    payload.issue.body = "Platforms: rocm";
    payload.issue.labels = [
      {
        name: "random label",
      },
      {
        name: "module: windows",
      },
    ];
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const number = payload.issue.number;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=10`)
      .reply(200, [])
      .post(
        `/repos/${owner}/${repo}/issues/${number}/comments`,
        (body) => !body.body.includes("don't have permission")
      )
      .reply(200)
      .put(`/repos/${owner}/${repo}/issues/${number}/labels`, (body) =>
        _.isEqual(body.labels, ["random label", "module: rocm"])
      )
      .reply(200, []);

    await probot.receive({ name: "issues", payload: payload, id: "2" });

    handleScope(scope);
  });

  test("issue with correct labels doesn't change", async () => {
    const payload = requireDeepCopy("./fixtures/issues.opened.json");
    payload.issue.title = "DISABLED testMethodName (testClass.TestSuite)";
    payload.issue.user.id = pytorchBotId;
    payload.issue.body = "Platforms: rocm";
    payload.issue.labels = [
      {
        name: "module: rocm",
      },
      {
        name: "random label",
      },
    ];
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const number = payload.issue.number;

    const scope = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=10`)
      .reply(200, [])
      .post(
        `/repos/${owner}/${repo}/issues/${number}/comments`,
        (body) => !body.body.includes("don't have permission")
      )
      .reply(200);
    await probot.receive({ name: "issues", payload: payload, id: "2" });

    handleScope(scope);
  });
});
