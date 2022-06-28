import { Probot } from "probot";
import * as utils from "./utils";
import myProbotApp, * as botUtils from "../lib/bot/verifyDisableTestIssueBot";

describe("verify-disable-test-issue", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = utils.testProbot();
    probot.load(myProbotApp);
  });

  test("issue opened with title starts w/ DISABLED: disable for win", async () => {
    const title = "DISABLED testMethodName (testClass.TestSuite)";
    const body = "whatever\nPlatforms:win\nyay";

    const platforms = botUtils.parseBody(body);
    const testName = botUtils.parseTitle(title);
    expect(platforms).toMatchObject([new Set(["win"]), new Set()]);
    expect(testName).toEqual("testMethodName (testClass.TestSuite)");

    const comment = botUtils.formValidationComment(testName, platforms);
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

    const platforms = botUtils.parseBody(body);
    const testName = botUtils.parseTitle(title);
    expect(platforms).toMatchObject([
      new Set(["windows", "rocm", "asan"]),
      new Set(),
    ]);
    expect(testName).toEqual("testMethodName (testClass.TestSuite)");

    const comment = botUtils.formValidationComment(testName, platforms);
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

    const platforms = botUtils.parseBody(body);
    const testName = botUtils.parseTitle(title);
    expect(platforms).toMatchObject([new Set(), new Set()]);
    expect(testName).toEqual("testMethodName (testClass.TestSuite)");

    const comment = botUtils.formValidationComment(testName, platforms);
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

    const platforms = botUtils.parseBody(body);
    const testName = botUtils.parseTitle(title);
    expect(platforms).toMatchObject([new Set(), new Set(["everything"])]);
    expect(testName).toEqual("testMethodName (testClass.TestSuite)");

    const comment = botUtils.formValidationComment(testName, platforms);
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
    const title = "DISABLED testMethodName   (quantization.core.test_workflow_ops.TestFakeQuantizeOps)";
    const body = "whatever\nPlatforms:\nyay";

    const platforms = botUtils.parseBody(body);
    const testName = botUtils.parseTitle(title);
    expect(platforms).toMatchObject([new Set(), new Set()]);
    expect(testName).toEqual("testMethodName   (quantization.core.test_workflow_ops.TestFakeQuantizeOps)");

    const comment = botUtils.formValidationComment(testName, platforms);
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(comment.includes("~15 minutes")).toBeTruthy();
    expect(comment.includes("ERROR")).toBeFalsy();
    expect(comment.includes("WARNING")).toBeFalsy();
  });

  test("issue opened with title starts w/ DISABLED: cannot parse test", async () => {
    const title = "DISABLED testMethodName   cuz it borked  ";
    const body = "whatever\nPlatforms:\nyay";

    const platforms = botUtils.parseBody(body);
    const testName = botUtils.parseTitle(title);
    expect(platforms).toMatchObject([new Set(), new Set()]);
    expect(testName).toEqual("testMethodName   cuz it borked");

    const comment = botUtils.formValidationComment(testName, platforms);
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(comment.includes("~15 minutes")).toBeFalsy();
    expect(comment.includes("ERROR")).toBeTruthy();
    expect(comment.includes("WARNING")).toBeFalsy();
  });

  test("issue opened with title starts w/ DISABLED: cannot parse test nor platforms", async () => {
    const title = "DISABLED testMethodName   cuz it borked  ";
    const body = "whatever\nPlatforms:all of them\nyay";

    const platforms = botUtils.parseBody(body);
    const testName = botUtils.parseTitle(title);
    expect(platforms).toMatchObject([new Set(), new Set(["all of them"])]);
    expect(testName).toEqual("testMethodName   cuz it borked");

    const comment = botUtils.formValidationComment(testName, platforms);
    expect(comment.includes("<!-- validation-comment-start -->")).toBeTruthy();
    expect(comment.includes("~15 minutes")).toBeFalsy();
    expect(comment.includes("ERROR")).toBeTruthy();
    expect(comment.includes("WARNING")).toBeTruthy();
  });
});
