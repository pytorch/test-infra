import { Probot } from "probot";
import * as utils from "./utils";
import myProbotApp, * as bot from "../lib/bot/verifyDisableTestIssueBot";
import * as botUtils from "../lib/bot/utils";

describe("verify-disable-test-issue", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
  });

  test("issue opened with title starts w/ DISABLED: disable for win", async () => {
    const title = "DISABLED testMethodName (testClass.TestSuite)";
    const body = "whatever\nPlatforms:win\nyay";

    const platforms = bot.parseBody(body);
    const testName = bot.parseTitle(title);
    expect(platforms).toMatchObject([new Set(["win"]), new Set()]);
    expect(testName).toEqual("testMethodName (testClass.TestSuite)");

    const comment = bot.formValidationComment(testName, platforms);
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
    const testName = bot.parseTitle(title);
    expect(platforms).toMatchObject([
      new Set(["windows", "rocm", "asan"]),
      new Set(),
    ]);
    expect(testName).toEqual("testMethodName (testClass.TestSuite)");

    const comment = bot.formValidationComment(testName, platforms);
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
    const testName = bot.parseTitle(title);
    expect(platforms).toMatchObject([new Set(), new Set()]);
    expect(testName).toEqual("testMethodName (testClass.TestSuite)");

    const comment = bot.formValidationComment(testName, platforms);
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
    const testName = bot.parseTitle(title);
    expect(platforms).toMatchObject([new Set(), new Set(["everything"])]);
    expect(testName).toEqual("testMethodName (testClass.TestSuite)");

    const comment = bot.formValidationComment(testName, platforms);
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
    const testName = bot.parseTitle(title);
    expect(platforms).toMatchObject([new Set(), new Set()]);
    expect(testName).toEqual(
      "testMethodName   (quantization.core.test_workflow_ops.TestFakeQuantizeOps)"
    );

    const comment = bot.formValidationComment(testName, platforms);
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(comment.includes("~15 minutes")).toBeTruthy();
    expect(comment.includes("ERROR")).toBeFalsy();
    expect(comment.includes("WARNING")).toBeFalsy();
  });

  test("issue opened with title starts w/ DISABLED: cannot parse test", async () => {
    const title = "DISABLED testMethodName   cuz it borked  ";
    const body = "whatever\nPlatforms:\nyay";

    const platforms = bot.parseBody(body);
    const testName = bot.parseTitle(title);
    expect(platforms).toMatchObject([new Set(), new Set()]);
    expect(testName).toEqual("testMethodName   cuz it borked");

    const comment = bot.formValidationComment(testName, platforms);
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(comment.includes("~15 minutes")).toBeFalsy();
    expect(comment.includes("ERROR")).toBeTruthy();
    expect(comment.includes("WARNING")).toBeFalsy();
  });

  test("issue opened with title starts w/ DISABLED: cannot parse test nor platforms", async () => {
    const title = "DISABLED testMethodName   cuz it borked  ";
    const body = "whatever\nPlatforms:all of them\nyay";

    const platforms = bot.parseBody(body);
    const testName = bot.parseTitle(title);
    expect(platforms).toMatchObject([new Set(), new Set(["all of them"])]);
    expect(testName).toEqual("testMethodName   cuz it borked");

    const comment = bot.formValidationComment(testName, platforms);
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

    const jobName = bot.parseTitle(title);
    expect(jobName).toEqual("pull / linux-bionic-py3.8-clang9");

    const spy = jest.spyOn(botUtils, "hasWritePermissions");

    spy.mockReturnValue(Promise.resolve(true));
    let comment = await bot.formJobValidationComment(
      "context",
      "mock-user",
      jobName
    );
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(comment.includes(`~15 minutes, \`${jobName}\``)).toBeTruthy();
    expect(comment.includes("ERROR")).toBeFalsy();

    spy.mockReturnValue(Promise.resolve(false));
    comment = await bot.formJobValidationComment(
      "context",
      "mock-user",
      jobName
    );
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(
      comment.includes("You (mock-user) don't have permission to disable")
    ).toBeTruthy();
    expect(comment.includes("ERROR")).toBeTruthy();

    spy.mockRestore();
  });
});
