import * as singleDisableIssue from "lib/flakyBot/singleDisableIssue";
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

  test("various singleDisableIssue.getExpectedPlatformModuleLabels tests", async () => {
    expect(
      await singleDisableIssue.getExpectedPlatformModuleLabels(
        ["linux"],
        ["random"]
      )
    ).toEqual([[], []]);
    expect(
      await singleDisableIssue.getExpectedPlatformModuleLabels(
        ["inductor"],
        ["random"]
      )
    ).toEqual([["oncall: pt2"], []]);
    expect(
      await singleDisableIssue.getExpectedPlatformModuleLabels(
        ["linux"],
        ["random", "module: rocm"]
      )
    ).toEqual([[], ["module: rocm"]]);
    expect(
      await singleDisableIssue.getExpectedPlatformModuleLabels(
        ["rocm"],
        ["random", "module: rocm"]
      )
    ).toEqual([["module: rocm"], []]);
    expect(
      await singleDisableIssue.getExpectedPlatformModuleLabels(
        ["dynamo", "inductor"],
        ["random", "module: rocm"]
      )
    ).toEqual([["oncall: pt2"], ["module: rocm"]]);
    expect(
      await singleDisableIssue.getExpectedPlatformModuleLabels(
        ["linux", "rocm"],
        ["random", "module: rocm"]
      )
    ).toEqual([[], ["module: rocm"]]);
    expect(
      await singleDisableIssue.getExpectedPlatformModuleLabels(
        ["linux", "rocm"],
        ["random", "module: rocm", "oncall: pt2"]
      )
    ).toEqual([[], ["module: rocm"]]);
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
});
