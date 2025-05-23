import { __forTesting__ as singleDisableIssue } from "lib/flakyBot/singleDisableIssue";
import nock from "nock";
import { flakyTestA } from "./flakyBotTestsUtils";

nock.disableNetConnect();
describe("Flaky Test Bot Single Issue Unit Tests", () => {
  test("getIssueBodyForFlakyTest: should contain Platforms line", async () => {
    expect(singleDisableIssue.getIssueBodyForFlakyTest(flakyTestA)).toContain(
      "Platforms: "
    );
  });

  test("getIssueBodyForFlakyTest: should contain correct examples URL", async () => {
    expect(singleDisableIssue.getIssueBodyForFlakyTest(flakyTestA)).toContain(
      "https://hud.pytorch.org/flakytest?name=test_a&suite=suite_a&limit=100"
    );
  });

  test("getIssueBodyForFlakyTest: should contain file info", async () => {
    expect(singleDisableIssue.getIssueBodyForFlakyTest(flakyTestA)).toContain(
      "Test file path: `file_a.py`"
    );
  });

  test("parseBody: bodyWithoutPlatforms preserves new lines", async () => {
    expect(
      singleDisableIssue.parseBody(
        "Platforms: win, rocm\r\nHello\r\n\nMy name is\n\n```a;dlskfja\ndklfj```"
      )
    ).toEqual({
      platformsToSkip: ["rocm", "win"],
      invalidPlatforms: [],
      bodyWithoutPlatforms:
        "\r\nHello\r\n\nMy name is\n\n```a;dlskfja\ndklfj```",
    });
    expect(singleDisableIssue.parseBody("Platforms: win, rocm\r\n")).toEqual({
      platformsToSkip: ["rocm", "win"],
      invalidPlatforms: [],
      bodyWithoutPlatforms: "\r\n",
    });
  });

  test("getExpectedLabels tests", async () => {
    function helper(
      body: string,
      existingLabels: string[],
      expectedLabels: string[]
    ) {
      expect(
        singleDisableIssue.getExpectedLabels(body, existingLabels)
      ).toEqual(expectedLabels);
    }
    helper("", ["module: rocm"], []);
    helper("", ["random"], ["random"]);
    helper("Platforms: linux, rocm", ["module: rocm", "random"], ["random"]);
    helper("Platforms: inductor, dynamo", ["module: windows"], ["oncall: pt2"]);
    helper("Platforms: linux", ["module: rocm"], []);
    helper("Platforms: inductor", ["random"], ["oncall: pt2", "random"]);
    helper("Platforms: ", ["random"], ["random"]);
    helper("Platforms: inductor", ["module: rocm"], ["oncall: pt2"]);
    helper("Platforms: dynamo", ["module: rocm"], ["oncall: pt2"]);
    helper(
      "Platforms: inductor, dynamo",
      ["module: rocm", "random"],
      ["oncall: pt2", "random"]
    );
    helper("Platforms: rocm", ["oncall: pt2"], ["module: rocm", "oncall: pt2"]);
  });

  test("getIssueTitle: test suite in subclass should not have __main__", async () => {
    expect(
      singleDisableIssue.getIssueTitle(
        "test_cool_op_cpu",
        "jit.async.SpecialSuite"
      )
    ).toEqual("DISABLED test_cool_op_cpu (jit.async.SpecialSuite)");
  });

  test("getIssueTitle: test suite not in subclass should be prefixed with __main__", async () => {
    expect(
      singleDisableIssue.getIssueTitle("test_cool_op_cpu", "TestLinAlgCPU")
    ).toEqual("DISABLED test_cool_op_cpu (__main__.TestLinAlgCPU)");
  });

  test("isSingleIssue: should return true for single issue", async () => {
    const areSingleIssues = [
      "DISABLED test_a (__main__.suite_a)",
      "DISABLED test_a (t.test_a)",
      "DISABLED test_a   (t.test_a.TestLinAlgCPU)",
      "DISABLED test_aDFSOIDJ (t.test_a.TestLinAlgCPU)",
    ];
    for (const issue of areSingleIssues) {
      expect(singleDisableIssue.isSingleIssue(issue)).toEqual(true);
    }

    const areNotSingleIssues = [
      "DISABLED MULTIPLE test_a (__main__.suite_a)",
      "UNSTABLE test_a (__main__.suite_a)",
      "DISABLED test_a asdf (__main__.suite_a)",
      "DISABLED test_a asdf (suite_a)",
    ];
    for (const issue of areNotSingleIssues) {
      expect(singleDisableIssue.isSingleIssue(issue)).toEqual(false);
    }
  });
});
