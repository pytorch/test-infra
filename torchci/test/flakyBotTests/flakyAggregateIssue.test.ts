import nock from "nock";
import { __forTesting__ as aggregateDisableIssue } from "../../lib/flakyBot/aggregateDisableIssue";
import { flakyTestA } from "./flakyBotTestsUtils";

nock.disableNetConnect();

describe("Flaky Test Bot Aggregate Issue Unit Tests", () => {
  test("getBody", () => {
    const body = aggregateDisableIssue.getBody([flakyTestA]);
    const shouldContain = [
      "disable the following tests:\n",
      "Test file path: `file_a.py`",
      "https://hud.pytorch.org/flakytest?name=test_a&suite=suite_a&limit=100",
      "test_a (__main__.suite_a): win\n",
    ];
    for (const str of shouldContain) {
      expect(body).toContain(str);
    }
    expect(
      body.startsWith(`There are multiple flaky tests in ${flakyTestA.file}. Please investigate and fix the flakiness.

disable the following tests:
\`\`\`
test_a (__main__.suite_a): win
\`\`\`

Here is an example for`)
    ).toEqual(true);
  });

  test("parseBody and getBody should correspond", async () => {
    const body = aggregateDisableIssue.getBody([flakyTestA]);
    const parsed = aggregateDisableIssue.parseBody(body);
    expect(parsed.platformMapping).toEqual(
      new Map([["test_a (__main__.suite_a)", ["win"]]])
    );
    expect(parsed.invalidPlatformMapping).toEqual(new Map());
    expect(parsed.failedToParse).toEqual([]);
    expect(
      parsed.bodyWithoutPlatforms.startsWith(
        "There are multiple flaky tests in file_a.py. Please investigate and fix the flakiness."
      )
    ).toEqual(true);
  });

  test("parseBody", () => {
    function _helper(body: string, expected: Map<string, string[]>) {
      const tests = aggregateDisableIssue.parseBody(body);
      expect(tests.platformMapping).toEqual(expected);
    }
    _helper("no tests", new Map());
    _helper("disable the following tests:\n```\n```", new Map());
    _helper(
      "disable the following tests:\n```test_a (__main__.testB): mac\n```",
      new Map([["test_a (__main__.testB)", ["mac"]]])
    );
    // random casing
    _helper(
      "DiSaBlE ThE FoLloWing tests:\n```test_a (__main__.testB): mac\n```",
      new Map([["test_a (__main__.testB)", ["mac"]]])
    );
    // Random extra block
    _helper(
      "disable the following tests:\n```test_a (__main__.testB): mac\n```test_a (testC): mac\n```",
      new Map([["test_a (__main__.testB)", ["mac"]]])
    );
    // Mutliple platforms
    _helper(
      "disable the following tests:\n```test_a (__main__.testB): mac, win\n```",
      new Map([["test_a (__main__.testB)", ["mac", "win"]]])
    );
    // No platforms (should be all)
    _helper(
      "disable the following tests:\n```test_a (__main__.testB):\n```",
      new Map([["test_a (__main__.testB)", []]])
    );
    // Multiple tests
    _helper(
      "disable the following tests:\n```test_1 (__main__.testB):\ntest_2 (__main__.testB):\n```",
      new Map([
        ["test_1 (__main__.testB)", []],
        ["test_2 (__main__.testB)", []],
      ])
    );
  });

  test("getTitle", () => {
    const title = aggregateDisableIssue.getTitle(flakyTestA);
    expect(title).toEqual(
      "DISABLED MULTIPLE There are multiple flaky tests in file_a.py"
    );
  });

  test("parsePlatformsFromString", () => {
    function _helper(platforms: string, expected: string[]) {
      const parsed = aggregateDisableIssue.parsePlatformsFromString(platforms);
      expect(parsed).toEqual(expected);
    }
    _helper("", []);
    _helper("mac", ["mac"]);
    _helper("mac, win", ["mac", "win"]);
    _helper("mac, win, linux", ["mac", "win", "linux"]);
    // Whitespace checks
    _helper("  ", []);
    _helper("mac,  win", ["mac", "win"]);
    _helper("mac,  win ", ["mac", "win"]);
    _helper("  mac,  win ", ["mac", "win"]);
  });

  test("formatTestsForBody", async () => {
    const body = aggregateDisableIssue.formatTestsForBody(
      new Map([
        ["test_a (__main__.suite_a)", ["win"]],
        ["test_b (__main__.suite_a)", ["win", "linux"]],
        ["test_c (__main__.suite_a)", []],
      ])
    );

    expect(body).toEqual(`disable the following tests:
\`\`\`
test_a (__main__.suite_a): win
test_b (__main__.suite_a): win, linux
test_c (__main__.suite_a):
\`\`\`
`);
  });
});
