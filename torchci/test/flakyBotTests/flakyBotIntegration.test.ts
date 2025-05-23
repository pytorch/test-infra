import dayjs from "dayjs";
import { __forTesting__ as aggregateDisableIssue } from "lib/flakyBot/aggregateDisableIssue";
import * as flakyBotUtils from "lib/flakyBot/utils";
import { FlakyTestData, IssueData } from "lib/types";
import nock from "nock";
import { __forTesting__ as disableFlakyTestBot } from "pages/api/flaky-tests/disable";
import { deepCopy, handleScope } from "../common";
import * as utils from "../utils";
import {
  flakyTestA,
  flakyTestB,
  genValidFlakyTest,
  mockGetRawTestFile,
  nonFlakyTestA,
} from "./flakyBotTestsUtils";

nock.disableNetConnect();

function mockUpdateIssue({
  issueNumber,
  labels,
  state,
  bodyContains,
}: {
  issueNumber: number;
  labels?: string[];
  state?: string;
  bodyContains?: string[];
}) {
  return nock("https://api.github.com")
    .patch(`/repos/pytorch/pytorch/issues/${issueNumber}`, (body) => {
      if (labels !== undefined) {
        expect(body).toMatchObject({ labels });
      }
      if (state !== undefined) {
        expect(body).toMatchObject({ state });
      }
      for (const containedString of bodyContains ?? []) {
        expect(body.body).toContain(containedString);
      }
      return true;
    })
    .reply(200, {});
}

describe("Disable Flaky Test Integration Tests", () => {
  const octokit = utils.testOctokit();

  beforeEach(() => {});

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  describe("Single Test Issue", () => {
    function genSingleIssueFor(
      test: FlakyTestData,
      input: Partial<IssueData>
    ): IssueData {
      return {
        number: 1,
        title: `DISABLED ${test.name} (__main__.${test.suite})`,
        html_url: "test url",
        state: "open" as "open" | "closed",
        body: `Platforms: ${flakyBotUtils.getPlatformsAffected(test.jobNames)}`,
        updated_at: dayjs().subtract(4, "hour").toString(),
        author_association: "MEMBER",
        labels: [],
        ...input,
      };
    }
    describe("Create/update issues", () => {
      test("Create new issue", async () => {
        const flakyTest = { ...flakyTestA };
        const scope = [
          mockGetRawTestFile(
            flakyTest.file,
            `# Owner(s): ["module: fft"]\nimport blah;\nrest of file`
          ),
          utils.mockCreateIssue(
            "pytorch/pytorch",
            "DISABLED test_a (__main__.suite_a)",
            ["Platforms: "],
            [
              "skipped",
              "module: flaky-tests",
              "module: fft",
              "module: windows",
              "triaged",
            ]
          ),
        ];

        await disableFlakyTestBot.handleAll(octokit, [flakyTest], [], [], []);

        handleScope(scope);
      });

      test("Comment on open issue", async () => {
        const flakyTest = { ...flakyTestA };
        const issues = [genSingleIssueFor(flakyTest, {})];

        const scope = [
          utils.mockPostComment("pytorch/pytorch", 1, [
            "Another case of trunk flakiness has been found",
            "appears to contain",
            "Either the change didn't propogate",
          ]),
        ];

        await disableFlakyTestBot.handleAll(
          octokit,
          [flakyTest],
          [],
          issues,
          []
        );

        handleScope(scope);
      });
      test("No reopen if flake is old", async () => {
        const flakyTest = {
          ...flakyTestA,
          eventTimes: [dayjs().subtract(5, "hour").toString()],
        };
        const issues = [genSingleIssueFor(flakyTest, { state: "closed" })];

        await disableFlakyTestBot.handleAll(
          octokit,
          [flakyTest],
          [],
          issues,
          []
        );
      });

      test("Add platforms", async () => {
        const flakyTest = { ...flakyTestA };
        const issues = [genSingleIssueFor(flakyTest, {})];
        flakyTest.jobNames = ["linux1", "linux2", "linux3"];

        const scope = [
          utils.mockPostComment("pytorch/pytorch", 1, [
            "Another case of trunk flakiness has been found",
            "list of platforms [win] does not appear to contain all",
          ]),
          mockUpdateIssue({
            issueNumber: 1,
            bodyContains: ["Platforms: win, linux"],
            state: "open",
          }),
        ];

        await disableFlakyTestBot.handleAll(
          octokit,
          [flakyTest],
          [],
          issues,
          []
        );

        handleScope(scope);
      });

      test("Do not modify platforms (no platforms string)", async () => {
        const flakyTest = { ...flakyTestA };
        const issues = [genSingleIssueFor(flakyTest, { body: "a\nb\nc" })];
        flakyTest.jobNames = ["linux1", "linux2", "linux3"];

        const scope = [
          utils.mockPostComment("pytorch/pytorch", 1, [
            "Another case of trunk flakiness has been found",
            "appears to contain all the recently affected",
          ]),
        ];

        await disableFlakyTestBot.handleAll(
          octokit,
          [flakyTest],
          [],
          issues,
          []
        );

        handleScope(scope);
      });

      test("Reopen and modify platforms", async () => {
        const test = deepCopy(flakyTestA);
        const issue = genSingleIssueFor(test, {
          body: "Platforms: linux\nhello\n\na\nb",
          state: "closed",
        });

        const scope = [
          mockUpdateIssue({
            issueNumber: issue.number,
            bodyContains: ["Platforms: linux, win"],
            state: "open",
          }),
          utils.mockPostComment("pytorch/pytorch", issue.number, [
            "Another case of trunk flakiness has been found",
            "does not appear to contain",
            "Adding [win]",
            "Reopening issue",
          ]),
        ];

        await disableFlakyTestBot.handleAll(octokit, [test], [], [issue], []);
        handleScope(scope);
      });

      test("Reopen issue, all platforms present", async () => {
        const test = deepCopy(flakyTestA);
        const issue = genSingleIssueFor(test, {
          body: "Platforms: win\nhello\n\na\nb",
          state: "closed",
        });

        const scope = [
          mockUpdateIssue({
            issueNumber: issue.number,
            state: "open",
          }),
          utils.mockPostComment("pytorch/pytorch", issue.number, [
            "Another case of trunk flakiness has been found",
            "appears to contain all the recently affected",
            "Reopening issue",
          ]),
        ];

        await disableFlakyTestBot.handleAll(octokit, [test], [], [issue], []);

        handleScope(scope);
      });

      test("Add platforms", async () => {
        const test = deepCopy(flakyTestA);
        const issue = genSingleIssueFor(test, {
          body: "Platforms: inductor, dynamo\nhello",
        });
        test.jobNames.push("rocm");
        test.workflowNames.push("test");

        const scope = [
          mockUpdateIssue({
            issueNumber: issue.number,
            state: "open",
            bodyContains: ["Platforms: dynamo, inductor, rocm", "hello"],
          }),

          utils.mockPostComment("pytorch/pytorch", issue.number, [
            "Another case of trunk flakiness has been found",
            "does not appear to contain",
            "Adding [rocm, win]",
          ]),
        ];

        await disableFlakyTestBot.handleAll(octokit, [test], [], [issue], []);

        handleScope(scope);
      });

      test("Reopen, add platforms", async () => {
        const test = deepCopy(flakyTestA);
        const issue = genSingleIssueFor(test, {
          body: "Platforms: win, dynamo\nhello",
          state: "closed",
        });

        const scope = [
          mockUpdateIssue({
            issueNumber: issue.number,
            state: "open",
          }),
          utils.mockPostComment("pytorch/pytorch", issue.number, [
            "Another case of trunk flakiness has been found",
            "appears to contain",
            "Reopening issue",
          ]),
        ];

        await disableFlakyTestBot.handleAll(octokit, [test], [], [issue], []);

        handleScope(scope);
      });

      test("No comment if flake is old", async () => {
        // Same as Comment on open issue, but with a different event time
        const flakyTest = {
          ...flakyTestA,
          eventTimes: [dayjs().subtract(5, "hour").toString()],
        };
        const issues = [genSingleIssueFor(flakyTest, {})];

        await disableFlakyTestBot.handleAll(
          octokit,
          [flakyTest],
          [],
          issues,
          []
        );
      });

      test("Reopen closed issue and comment", async () => {
        const flakyTest = { ...flakyTestA };
        const issues = [genSingleIssueFor(flakyTest, { state: "closed" })];

        const scope = [
          mockUpdateIssue({
            issueNumber: 1,
            state: "open",
          }),
          utils.mockPostComment("pytorch/pytorch", 1, [
            "Another case of trunk flakiness has been found",
            "appears to contain",
            "Reopening",
          ]),
        ];

        await disableFlakyTestBot.handleAll(
          octokit,
          [flakyTest],
          [],
          issues,
          []
        );

        handleScope(scope);
      });
    });

    describe("Close no longer flaky tests", () => {
      const flakyTestIssue = genSingleIssueFor(
        genValidFlakyTest({ ...nonFlakyTestA, suite: nonFlakyTestA.classname }),
        {
          updated_at: dayjs()
            .subtract(
              flakyBotUtils.NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING + 1,
              "hour"
            )
            .toISOString(),
        }
      );

      test("Comment and close", async () => {
        const scope = [
          utils.mockPostComment("pytorch/pytorch", 1, [
            "Resolving the issue because the test is not flaky anymore",
          ]),
          mockUpdateIssue({
            issueNumber: 1,
            state: "closed",
          }),
        ];

        const issues: IssueData[] = [{ ...flakyTestIssue }];

        await disableFlakyTestBot.handleAll(octokit, [], [], issues, [
          nonFlakyTestA,
        ]);

        handleScope(scope);
      });

      test("Do nothing if issue updated recently", async () => {
        const issues: IssueData[] = [
          {
            ...flakyTestIssue,
            updated_at: dayjs()
              .subtract(
                flakyBotUtils.NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING - 1,
                "hour"
              )
              .toISOString(),
          },
        ];
        await disableFlakyTestBot.handleAll(octokit, [], [], issues, [
          nonFlakyTestA,
        ]);
      });
    });
  });

  describe("Aggregate Test Issue", () => {
    function genAggTests(test: FlakyTestData) {
      return Array.from({ length: 11 }, (_, i) =>
        genValidFlakyTest({
          ...test,

          name: `test_${i}`,
          suite: `suite_${i}`,
        })
      );
    }
    function genAggIssueFor(
      tests: FlakyTestData[],
      input: Partial<IssueData>
    ): IssueData {
      return {
        number: 1,
        title: aggregateDisableIssue.getTitle(tests[0]),
        html_url: "test url",
        state: "open" as "open" | "closed",
        body: aggregateDisableIssue.getBody(tests),
        updated_at: dayjs().subtract(4, "hour").toString(),
        author_association: "MEMBER",
        labels: [],
        ...input,
      };
    }

    describe("Create/update issues", () => {
      test("Create new issue", async () => {
        const tests = genAggTests(flakyTestA);
        const scope = [
          mockGetRawTestFile(
            tests[0].file,
            `# Owner(s): ["module: fft"]\nimport blah;\nrest of file`
          ),
          utils.mockCreateIssue(
            "pytorch/pytorch",
            `DISABLED MULTIPLE There are multiple flaky tests in ${tests[0].file}`,
            ["Platforms: "],
            [
              "aggregate flaky test issue",
              "skipped",
              "module: flaky-tests",
              "module: windows",
              "module: fft",
              "triaged",
            ]
          ),
        ];

        await disableFlakyTestBot.handleAll(octokit, tests, [], [], []);

        handleScope(scope);
      });

      test("Create two new issues", async () => {
        const tests = [...genAggTests(flakyTestA), ...genAggTests(flakyTestB)];
        const scope = [
          mockGetRawTestFile(
            tests[0].file,
            `# Owner(s): ["module: fft"]\nimport blah;\nrest of file`
          ),
          mockGetRawTestFile(
            tests[tests.length - 1].file,
            `# Owner(s): ["module: idk"]\nimport blah;\nrest of file`
          ),
          utils.mockCreateIssue(
            "pytorch/pytorch",
            `DISABLED MULTIPLE There are multiple flaky tests in ${tests[0].file}`,
            ["Platforms: "],
            [
              "aggregate flaky test issue",
              "skipped",
              "module: flaky-tests",
              "module: windows",
              "module: fft",
              "triaged",
            ]
          ),
          utils.mockCreateIssue(
            "pytorch/pytorch",
            `DISABLED MULTIPLE There are multiple flaky tests in ${
              tests[tests.length - 1].file
            }`,
            ["Platforms: "],
            [
              "aggregate flaky test issue",
              "skipped",
              "module: idk",
              "module: flaky-tests",
              "module: windows",
              "triaged",
            ]
          ),
        ];

        await disableFlakyTestBot.handleAll(octokit, tests, [], [], []);

        handleScope(scope);
      });

      test("Comment on open issue", async () => {
        const tests = genAggTests(flakyTestA);
        const issues = [genAggIssueFor(tests, {})];

        const scope = [
          utils.mockPostComment("pytorch/pytorch", 1, [
            "Another case of trunk flakiness has been found",
            "appear to contain",
            "Either the change didn't propogate",
          ]),
        ];

        await disableFlakyTestBot.handleAll(octokit, tests, [], issues, []);

        handleScope(scope);
      });

      test("No recomment if flake is old", async () => {
        const tests = genAggTests({
          ...flakyTestA,
          eventTimes: [dayjs().subtract(5, "hour").toString()],
        });
        const issues = [genAggIssueFor(tests, {})];

        await disableFlakyTestBot.handleAll(octokit, tests, [], issues, []);
      });

      test("Add platforms for all tests", async () => {
        const tests = genAggTests({
          ...flakyTestA,
        });
        const issues = [genAggIssueFor(tests, {})];
        tests.forEach((test) => {
          test.jobNames = ["linux1", "linux2", "linux3"];
        });

        const scope = [
          utils.mockPostComment("pytorch/pytorch", 1, [
            "Another case of trunk flakiness has been found",
            "lists of platforms does not appear",
          ]),
          mockUpdateIssue({
            issueNumber: 1,
            bodyContains: ["test_10 (__main__.suite_10): linux, win"],
          }),
        ];

        await disableFlakyTestBot.handleAll(octokit, tests, [], issues, []);

        handleScope(scope);
      });

      test("Add platforms for a few tests", async () => {
        const tests = genAggTests({
          ...flakyTestA,
        });
        const issues = [genAggIssueFor(tests, {})];
        tests[4].jobNames = ["linux1", "linux2", "linux3"];
        tests[7].jobNames = ["linux1", "linux2", "linux3"];

        const scope = [
          utils.mockPostComment("pytorch/pytorch", 1, [
            "Another case of trunk flakiness has been found",
            "lists of platforms does not appear",
          ]),
          mockUpdateIssue({
            issueNumber: 1,
            bodyContains: [
              "test_2 (__main__.suite_2): win\n",
              "test_4 (__main__.suite_4): linux, win\n",
              "test_7 (__main__.suite_7): linux, win\n",
              "test_5 (__main__.suite_5): win\n",
            ],
          }),
        ];

        await disableFlakyTestBot.handleAll(octokit, tests, [], issues, []);

        handleScope(scope);
      });

      test("Do not modify platforms (no platforms string)", async () => {
        const tests = genAggTests({ ...flakyTestA });
        const issues = [genAggIssueFor(tests, {})];
        issues[0].body.replaceAll(": win\n", ":\n");

        const scope = [
          utils.mockPostComment("pytorch/pytorch", 1, [
            "Another case of trunk flakiness has been found",
            "appear to contain all the recently affected platform",
          ]),
        ];

        await disableFlakyTestBot.handleAll(octokit, tests, [], issues, []);

        handleScope(scope);
      });

      test("Never reopen, always make a new one", async () => {
        const tests = genAggTests({ ...flakyTestA });
        const issues = [genAggIssueFor(tests, {})];
        issues[0].state = "closed";

        const scope = [
          mockGetRawTestFile(
            tests[0].file,
            `# Owner(s): ["module: fft"]\nimport blah;\nrest of file`
          ),
          utils.mockCreateIssue(
            "pytorch/pytorch",
            `DISABLED MULTIPLE There are multiple flaky tests in ${tests[0].file}`,
            ["Platforms: "],
            [
              "aggregate flaky test issue",
              "skipped",
              "module: flaky-tests",
              "module: windows",
              "module: fft",
              "triaged",
            ]
          ),
        ];
        await disableFlakyTestBot.handleAll(octokit, tests, [], issues, []);
        handleScope(scope);
      });

      test("All platforms present", async () => {
        const tests = genAggTests({ ...flakyTestA });
        const issues = [genAggIssueFor(tests, {})];

        const scope = [
          utils.mockPostComment("pytorch/pytorch", 1, [
            "Another case of trunk flakiness has been found",
            "appear to contain all the recently affected platform",
          ]),
        ];

        await disableFlakyTestBot.handleAll(octokit, tests, [], issues, []);
        handleScope(scope);
      });
    });

    describe("Close no longer flaky tests", () => {
      const tests = genAggTests(
        genValidFlakyTest({
          ...nonFlakyTestA,
          suite: nonFlakyTestA.classname,
        })
      );

      const flakyTestIssue = genAggIssueFor(tests, {
        updated_at: dayjs()
          .subtract(
            flakyBotUtils.NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING + 1,
            "hour"
          )
          .toISOString(),
      });

      test("Some tests are no longer flaky", async () => {
        const scope = [
          utils.mockPostComment("pytorch/pytorch", 1, [
            "The following tests were removed from the list",
          ]),
          mockUpdateIssue({
            issueNumber: 1,
            bodyContains: ["test_2 (__main__.suite_2): linux\n"],
          }),
        ];

        const issues: IssueData[] = [{ ...flakyTestIssue }];

        await disableFlakyTestBot.handleAll(octokit, [], [], issues, [
          {
            ...nonFlakyTestA,
            classname: "suite_0",
            name: "test_0",
          },
          {
            ...nonFlakyTestA,
            classname: "suite_1",
            name: "test_1",
          },
        ]);

        handleScope(scope);
      });

      test("All tests are no longer flaky", async () => {
        const scope = [
          utils.mockPostComment("pytorch/pytorch", 1, [
            "Resolving the issue because the tests are no longer flaky",
          ]),
          mockUpdateIssue({
            issueNumber: 1,
            state: "closed",
          }),
        ];

        const issues: IssueData[] = [{ ...flakyTestIssue }];

        await disableFlakyTestBot.handleAll(
          octokit,
          [],
          [],
          issues,
          Array.from({ length: 11 }, (_, i) => {
            return {
              ...nonFlakyTestA,
              classname: `suite_${i}`,
              name: `test_${i}`,
            };
          })
        );

        handleScope(scope);
      });

      test("Do nothing if issue updated recently", async () => {
        const issues: IssueData[] = [
          {
            ...flakyTestIssue,
            updated_at: dayjs()
              .subtract(
                flakyBotUtils.NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING - 1,
                "hour"
              )
              .toISOString(),
          },
        ];
        await disableFlakyTestBot.handleAll(octokit, [], [], issues, [
          {
            ...nonFlakyTestA,
            classname: "suite_0",
            name: "test_0",
          },
          {
            ...nonFlakyTestA,
            classname: "suite_1",
            name: "test_1",
          },
        ]);
      });
    });
  });
});
