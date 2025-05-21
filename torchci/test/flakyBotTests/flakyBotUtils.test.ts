import * as singleDisableIssue from "lib/flakyBot/singleDisableIssue";
import * as flakyBotUtils from "lib/flakyBot/utils";
import { IssueData } from "lib/types";
import nock from "nock";
import * as flakyBot from "pages/api/flaky-tests/disable";
import { deepCopy, handleScope } from "test/common";
import {
  flakyTestA,
  flakyTestAcrossJobA,
  flakyTestB,
  flakyTestE,
  mockGetRawTestFile,
  nonFlakyTestA,
  nonFlakyTestZ,
} from "test/flakyBotTests/flakyBotTestsUtils";
import * as utils from "test/utils";

describe("Disable Flaky Test Bot Unit Tests", () => {
  const octokit = utils.testOctokit();

  beforeEach(() => {});

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("filterOutPRFlakyTests: correctly filters and updates flaky test list", async () => {
    const flakyTests = [
      flakyTestA,
      {
        file: "file_b.py",
        invoking_file: "file_b",
        suite: "suite_b",
        name: "test_b",
        numGreen: 4,
        numRed: 2,
        workflowIds: ["12345678"],
        workflowNames: ["pull"],
        jobIds: [56789123],
        jobNames: ["win-cpu-vs-2019 / test"],
        branches: ["ciflow/all/12345"],
      },
      {
        file: "file_c.py",
        invoking_file: "file_c",
        suite: "suite_c",
        name: "test_c",
        numGreen: 4,
        numRed: 2,
        workflowIds: ["12345678", "13456789", "14253647"],
        workflowNames: ["pull", "periodic", "trunk"],
        jobIds: [54545454, 55555555, 56565656],
        jobNames: [
          "win-cpu-vs-2019 / test",
          "linux-xenial-cuda11.5-py3 / test",
          "macos-11-x86 / test",
        ],
        branches: ["master", "gh/janeyx99/idk", "master"],
      },
      {
        file: "file_d.py",
        invoking_file: "file_d",
        suite: "suite_d",
        name: "test_d",
        numGreen: 4,
        numRed: 2,
        workflowIds: ["12345678", "13456789"],
        workflowNames: ["pull", "periodic"],
        jobIds: [54545454, 55555555],
        jobNames: ["win-cpu-vs-2019 / test", "win-cuda11.3-vs-2019 / test"],
        branches: ["quick-fix", "ciflow/scheduled/22222"],
      },
      flakyTestE,
    ];
    const expectedFlakyTestsOnTrunk = [
      flakyTestA,
      {
        file: "file_c.py",
        invoking_file: "file_c",
        suite: "suite_c",
        name: "test_c",
        numGreen: 4,
        numRed: 2,
        workflowIds: ["12345678", "13456789", "14253647"],
        workflowNames: ["pull", "periodic", "trunk"],
        jobIds: [54545454, 55555555, 56565656],
        jobNames: [
          "win-cpu-vs-2019 / test",
          "linux-xenial-cuda11.5-py3 / test",
          "macos-11-x86 / test",
        ],
        branches: ["master", "gh/janeyx99/idk", "master"],
      },
      flakyTestE,
    ];
    expect(flakyBot.filterOutPRFlakyTests(flakyTests)).toEqual(
      expectedFlakyTestsOnTrunk
    );
  });

  test("getTestOwnerLabels: owned test file should return proper module and be triaged", async () => {
    const scope = mockGetRawTestFile(
      flakyTestA.file,
      `# Owner(s): ["module: fft"]\nimport blah;\nrest of file`
    );
    const { labels, additionalErrMessage } =
      await flakyBotUtils.getTestOwnerLabels(flakyTestA);
    expect(additionalErrMessage).toEqual(undefined);
    expect(labels).toEqual(["module: fft", "module: windows", "triaged"]);

    handleScope(scope);
  });

  test("getTestOwnerLabels: owned test file should route to oncall and NOT be triaged", async () => {
    const scope = mockGetRawTestFile(
      flakyTestA.file,
      `# Owner(s): ["oncall: distributed"]\nimport blah;\nrest of file`
    );

    const { labels } = await flakyBotUtils.getTestOwnerLabels(flakyTestA);
    expect(labels).toEqual([
      "oncall: distributed",
      "module: windows",
      "triaged",
    ]);

    handleScope(scope);
  });

  test("getTestOwnerLabels: un-owned test file should return module: unknown", async () => {
    const scope = mockGetRawTestFile(
      flakyTestA.file,
      `# Owner(s): ["module: unknown"]\nimport blah;\nrest of file`
    );

    const { labels, additionalErrMessage } =
      await flakyBotUtils.getTestOwnerLabels(flakyTestA);
    expect(labels).toEqual(["module: unknown", "module: windows", "triaged"]);
    expect(additionalErrMessage).toEqual(undefined);

    handleScope(scope);
  });

  test("getTestOwnerLabels: ill-formatted file should return module: unknown", async () => {
    const scope = mockGetRawTestFile(
      flakyTestA.file,
      `line1\nline2\nline3\nstill no owners\nline4\nlastline\n`
    );

    const { labels, additionalErrMessage } =
      await flakyBotUtils.getTestOwnerLabels(flakyTestA);
    expect(labels).toEqual(["module: windows", "triaged"]);
    expect(additionalErrMessage).toEqual(undefined);

    handleScope(scope);
  });

  test("getTestOwnerLabels: retry getting file fails all times", async () => {
    const scope = nock("https://raw.githubusercontent.com/")
      .get(`/pytorch/pytorch/main/test/${flakyTestA.file}`)
      .reply(404)
      .get(`/pytorch/pytorch/main/test/${flakyTestA.file}`)
      .reply(404)
      .get(`/pytorch/pytorch/main/test/${flakyTestA.file}`)
      .reply(404)
      .get(`/pytorch/pytorch/main/test/${flakyTestA.file}`)
      .reply(404)
      .get(`/pytorch/pytorch/main/test/${flakyTestA.invoking_file}.py`)
      .reply(404)
      .get(`/pytorch/pytorch/main/test/${flakyTestA.invoking_file}.py`)
      .reply(404)
      .get(`/pytorch/pytorch/main/test/${flakyTestA.invoking_file}.py`)
      .reply(404)
      .get(`/pytorch/pytorch/main/test/${flakyTestA.invoking_file}.py`)
      .reply(404);

    const { labels, additionalErrMessage } =
      await flakyBotUtils.getTestOwnerLabels(flakyTestA);
    expect(labels).toEqual(["module: windows", "triaged"]);
    expect(additionalErrMessage).toEqual(
      "Error: Error retrieving file_a.py: 404, file_a: 404"
    );

    handleScope(scope);
  });

  test("getTestOwnerLabels: retry getting file", async () => {
    const scope = nock("https://raw.githubusercontent.com/")
      .get(`/pytorch/pytorch/main/test/${flakyTestA.file}`)
      .reply(404)
      .get(`/pytorch/pytorch/main/test/${flakyTestA.file}`)
      .reply(
        200,
        Buffer.from(`# Owner(s): ["module: fft"]\nimport blah;\nrest of file`)
      );
    const { labels, additionalErrMessage } =
      await flakyBotUtils.getTestOwnerLabels(flakyTestA);
    expect(labels).toEqual(["module: fft", "module: windows", "triaged"]);
    expect(additionalErrMessage).toEqual(undefined);

    handleScope(scope);
  });

  test("getTestOwnerLabels: fallback to invoking file when retrieving file", async () => {
    const scope = nock("https://raw.githubusercontent.com/")
      .get(`/pytorch/pytorch/main/test/${flakyTestAcrossJobA.file}`)
      .reply(404)
      .get(`/pytorch/pytorch/main/test/${flakyTestAcrossJobA.file}`)
      .reply(404)
      .get(`/pytorch/pytorch/main/test/${flakyTestAcrossJobA.file}`)
      .reply(404)
      .get(`/pytorch/pytorch/main/test/${flakyTestAcrossJobA.file}`)
      .reply(404)
      .get(`/pytorch/pytorch/main/test/${flakyTestAcrossJobA.invoking_file}.py`)
      .reply(
        200,
        Buffer.from(`# Owner(s): ["module: fft"]\nimport blah;\nrest of file`)
      );
    const { labels, additionalErrMessage } =
      await flakyBotUtils.getTestOwnerLabels(flakyTestAcrossJobA);
    expect(labels).toEqual(["module: fft", "module: rocm", "triaged"]);
    expect(additionalErrMessage).toEqual(undefined);

    handleScope(scope);
  });

  test("getTestOwnerLabels: give dynamo and inductor oncall: pt2 label", async () => {
    const test = { ...flakyTestA };
    test.jobNames = ["dynamo linux"];

    let scope = mockGetRawTestFile(
      test.file,
      `# Owner(s): ["module: fft"]\nimport blah;\nrest of file`
    );

    let { labels, additionalErrMessage } =
      await flakyBotUtils.getTestOwnerLabels(test);
    expect(additionalErrMessage).toEqual(undefined);
    expect(labels).toEqual(["module: fft", "oncall: pt2"]);

    handleScope(scope);
  });

  test("getTestOwnerLabels: give dynamo and inductor oncall: pt2 label, unknown owner", async () => {
    const test = { ...flakyTestA };
    test.jobNames = ["inductor linux"];

    let scope = mockGetRawTestFile(test.file, `import blah;\nrest of file`);
    let { labels, additionalErrMessage } =
      await flakyBotUtils.getTestOwnerLabels(test);
    expect(additionalErrMessage).toEqual(undefined);
    expect(labels).toEqual(["oncall: pt2"]);

    handleScope(scope);
  });

  test("getTestOwnerLabels: unique platforms get labels", async () => {
    const test = { ...flakyTestA };
    test.jobNames = ["rocm"];

    let scope = mockGetRawTestFile(test.file, `import blah;\nrest of file`);
    let { labels, additionalErrMessage } =
      await flakyBotUtils.getTestOwnerLabels(test);
    expect(additionalErrMessage).toEqual(undefined);
    expect(labels).toEqual(["module: rocm", "triaged"]);

    handleScope(scope);
  });

  test("getTestOwnerLabels: multiple platforms do not get labels", async () => {
    const test = { ...flakyTestA };
    test.jobNames = ["rocm", "linux"];

    let scope = mockGetRawTestFile(test.file, `import blah;\nrest of file`);

    let { labels, additionalErrMessage } =
      await flakyBotUtils.getTestOwnerLabels(test);
    expect(additionalErrMessage).toEqual(undefined);
    expect(labels).toEqual(["module: unknown"]);

    handleScope(scope);
  });

  test("getLatestTrunkJobURL: should return URL of last trunk job if it exists", async () => {
    expect(flakyBotUtils.getLatestTrunkJobURL(flakyTestE)).toEqual(
      "https://github.com/pytorch/pytorch/runs/56789876"
    );
  });

  test("getLatestTrunkJobURL: should return URL of last job if no trunk instance exists", async () => {
    expect(flakyBotUtils.getLatestTrunkJobURL(flakyTestA)).toEqual(
      "https://github.com/pytorch/pytorch/runs/56789876"
    );
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

  test("getWorkflowJobNames: should zip the workflow and job names of a test", async () => {
    expect(flakyBotUtils.getWorkflowJobNames(flakyTestA)).toEqual([
      "trunk / win-cpu-vs-2019 / test",
      "periodic / win-cuda11.3-vs-2019 / test",
      "periodic / win-cuda11.3-vs-2019 / test",
    ]);
  });

  test("getPlatformsAffected: should correctly triage workflows of one platform", async () => {
    const workflowJobNames = [
      "periodic / linux-cuda11.1-py3 / test",
      "pull / whatever-whatever-linux / build",
    ];
    expect(flakyBotUtils.getPlatformsAffected(workflowJobNames)).toEqual([
      "linux",
    ]);
  });

  test("getPlatformsAffected: should correctly triage workflows of various platforms", async () => {
    const workflowJobs = flakyBotUtils.getWorkflowJobNames(flakyTestE);
    expect(flakyBotUtils.getPlatformsAffected(workflowJobs)).toEqual([
      "linux",
      "mac",
      "macos",
      "win",
    ]);
  });

  test("getPlatformsAffected: should correctly triage rocm without linux", async () => {
    const workflowJobs = ["pull / whatever-rocm-linux / build"];
    expect(flakyBotUtils.getPlatformsAffected(workflowJobs)).toEqual(["rocm"]);
  });

  test("getPlatformsAffected: should correctly triage dyanmo and inductor", async () => {
    function expectJobsToDisablePlatforms(jobs: string[], platforms: string[]) {
      expect(flakyBotUtils.getPlatformsAffected(jobs)).toEqual(platforms);
    }

    expectJobsToDisablePlatforms(
      ["linux rocm", "dynamo linux", "inductor linux", "linux"],
      ["linux", "rocm"]
    );

    expectJobsToDisablePlatforms(
      ["linux rocm", "dynamo linux", "inductor linux"],
      ["rocm", "dynamo", "inductor"]
    );

    expectJobsToDisablePlatforms(
      ["dynamo linux", "inductor linux"],
      ["dynamo", "inductor"]
    );

    expectJobsToDisablePlatforms(
      ["linux rocm", "dynamo linux", "linux"],
      ["linux", "rocm"]
    );

    expectJobsToDisablePlatforms(
      ["linux rocm", "inductor linux", "linux"],
      ["linux", "rocm"]
    );

    expectJobsToDisablePlatforms(["dynamo linux", "linux"], ["linux"]);

    expectJobsToDisablePlatforms(["inductor linux", "linux"], ["linux"]);

    expectJobsToDisablePlatforms(
      ["inductor linux", "rocm linux"],
      ["rocm", "inductor"]
    );

    expectJobsToDisablePlatforms(["inductor linux"], ["inductor"]);

    expectJobsToDisablePlatforms(["dynamo linux"], ["dynamo"]);
  });

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

  test("filterOutNonFlakyTest: should not contain any flaky tests", async () => {
    const disabledNonFlakyTests = [nonFlakyTestA, nonFlakyTestZ];

    const flakyTests = [flakyTestA, flakyTestB];

    expect(
      flakyBot.filterOutNonFlakyTests(disabledNonFlakyTests, flakyTests)
    ).toEqual([nonFlakyTestZ]);
  });

  test("dedupFlakyTestIssues favors correct issues", async () => {
    const openSmall: IssueData = {
      number: 1,
      title: "",
      html_url: "",
      state: "open",
      body: "",
      updated_at: "",
      author_association: "MEMBER",
      labels: [],
    };
    const closedSmall: IssueData = { ...openSmall, number: 2, state: "closed" };
    const openBig: IssueData = { ...openSmall, number: 3 };
    const closedBig: IssueData = { ...openSmall, number: 4, state: "closed" };

    async function helper(
      input: IssueData[],
      expected: IssueData,
      closed: IssueData[]
    ) {
      const scope = nock("https://api.github.com");
      for (const issue of closed) {
        scope.patch(`/repos/pytorch/pytorch/issues/${issue.number}`).reply(200);
      }
      expect(await flakyBot.dedupFlakyTestIssues(octokit, input)).toEqual([
        expected,
      ]);
      scope.done();
    }

    // Definitely not the entire range of possibilities
    await helper([openSmall], openSmall, []);
    await helper([openSmall, closedSmall], openSmall, []);
    await helper([openSmall, openBig, closedSmall], openBig, [openSmall]);
    await helper([openSmall, openBig], openBig, [openSmall]);
    await helper([openSmall, openBig, closedBig, closedSmall], openBig, [
      openSmall,
    ]);
    await helper([closedSmall, closedBig], closedBig, []);
    await helper([closedSmall, openSmall], openSmall, []);
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

  describe("updateExistingIssueForFlakyTest", () => {
    const defaultIssue = utils.genIssueData({});
    beforeEach(() => {});

    afterEach(() => {
      nock.cleanAll();
      jest.restoreAllMocks();
    });

    test("open issue, contains platforms", async () => {
      const test = deepCopy(flakyTestA);

      const scope = nock("https://api.github.com");
      scope
        .post(
          `/repos/pytorch/pytorch/issues/${defaultIssue.number}/comments`,
          (body) => {
            const comment = JSON.stringify(body.body);
            expect(comment).toContain("Another case of trunk flakiness");
            expect(comment).toContain("appears to contain");
            expect(comment).toContain("Either the change didn't propogate");
            expect(comment.includes("Reopening issue")).toBe(false);
            return true;
          }
        )
        .reply(200, {});

      await singleDisableIssue.updateExistingIssueForFlakyTest(
        octokit,
        defaultIssue,
        test
      );

      handleScope(scope);
    });

    test("closed issue, contains platforms", async () => {
      const test = deepCopy(flakyTestA);
      const issue: IssueData = { ...defaultIssue, state: "closed" };

      const scope = nock("https://api.github.com");
      scope
        .post(
          `/repos/pytorch/pytorch/issues/${issue.number}/comments`,
          (body) => {
            const comment = JSON.stringify(body.body);
            expect(comment).toContain("Another case of trunk flakiness");
            expect(comment).toContain("appears to contain");
            expect(comment).toContain("Reopening issue");
            expect(comment.includes("Either the change didn't propogate")).toBe(
              false
            );
            return true;
          }
        )
        .reply(200, {})
        .patch(`/repos/pytorch/pytorch/issues/${issue.number}`, (body) => {
          expect(body.state).toEqual("open");
          expect(body.body).toBe(undefined);
          return true;
        })
        .reply(200, {});

      await singleDisableIssue.updateExistingIssueForFlakyTest(
        octokit,
        issue,
        test
      );

      handleScope(scope);
    });

    test("open issue, does not contain platforms", async () => {
      const test = deepCopy(flakyTestA);
      const issue: IssueData = {
        ...defaultIssue,
        body: "Platforms: linux\nhello",
      };

      const scope = nock("https://api.github.com");
      scope
        .post(
          `/repos/pytorch/pytorch/issues/${issue.number}/comments`,
          (body) => {
            const comment = JSON.stringify(body.body);
            expect(comment).toContain("Another case of trunk flakiness");
            expect(comment).toContain("Adding [win]");
            expect(comment.includes("Reopening issue")).toBe(false);
            expect(comment.includes("Either the change didn't propogate")).toBe(
              false
            );
            return true;
          }
        )
        .reply(200, {})
        .patch(`/repos/pytorch/pytorch/issues/${issue.number}`, (body) => {
          expect(body.state).toEqual("open");
          expect(body.body).toContain("Platforms: linux, win");
          expect(body.body).toContain("hello");
          return true;
        })
        .reply(200, {});

      await singleDisableIssue.updateExistingIssueForFlakyTest(
        octokit,
        issue,
        test
      );

      handleScope(scope);
    });

    test("closed issue, does not contain platforms", async () => {
      const test = deepCopy(flakyTestA);
      const issue: IssueData = {
        ...defaultIssue,
        body: "Platforms: linux\nhello",
        state: "closed",
      };

      const scope = nock("https://api.github.com");
      scope
        .post(
          `/repos/pytorch/pytorch/issues/${issue.number}/comments`,
          (body) => {
            const comment = JSON.stringify(body.body);
            expect(comment).toContain("Another case of trunk flakiness");
            expect(comment).toContain("does not appear to contain");
            expect(comment).toContain("Adding [win]");
            expect(comment).toContain("Reopening issue");
            expect(comment.includes("Either the change didn't propogate")).toBe(
              false
            );
            return true;
          }
        )
        .reply(200, {})
        .patch(`/repos/pytorch/pytorch/issues/${issue.number}`, (body) => {
          expect(body.body).toContain("Platforms: linux, win");
          expect(body.body).toContain("hello");
          expect(body.state).toEqual("open");
          return true;
        })
        .reply(200, {});

      await singleDisableIssue.updateExistingIssueForFlakyTest(
        octokit,
        issue,
        test
      );

      handleScope(scope);
    });

    test("open issue, does not contain platforms, longer platforms lists", async () => {
      const test = deepCopy(flakyTestA);
      test.jobNames.push("rocm");
      test.workflowNames.push("test");
      const issue: IssueData = {
        ...defaultIssue,
        body: "Platforms: inductor, dynamo\nhello",
        state: "closed",
      };

      const scope = nock("https://api.github.com");
      scope
        .post(
          `/repos/pytorch/pytorch/issues/${issue.number}/comments`,
          (body) => {
            const comment = JSON.stringify(body.body);
            expect(comment).toContain("Another case of trunk flakiness");
            expect(comment).toContain("does not appear to contain");
            expect(comment).toContain("Adding [rocm, win]");
            expect(comment).toContain("Reopening issue");
            expect(comment.includes("Either the change didn't propogate")).toBe(
              false
            );
            return true;
          }
        )
        .reply(200, {})
        .patch(`/repos/pytorch/pytorch/issues/${issue.number}`, (body) => {
          expect(body.body).toContain("Platforms: dynamo, inductor, rocm, win");
          expect(body.body).toContain("hello");
          expect(body.state).toEqual("open");
          return true;
        })
        .reply(200, {});

      await singleDisableIssue.updateExistingIssueForFlakyTest(
        octokit,
        issue,
        test
      );

      handleScope(scope);
    });

    test("closed issue, contains platforms, longer platforms lists", async () => {
      const test = deepCopy(flakyTestA);
      const issue: IssueData = {
        ...defaultIssue,
        body: "Platforms: win\nhello",
        state: "closed",
      };

      const scope = nock("https://api.github.com");
      scope
        .post(
          `/repos/pytorch/pytorch/issues/${issue.number}/comments`,
          (body) => {
            const comment = JSON.stringify(body.body);
            expect(comment).toContain("Another case of trunk flakiness");
            expect(comment).toContain("appears to contain");
            expect(comment).toContain("Reopening issue");
            expect(comment.includes("Either the change didn't propogate")).toBe(
              false
            );
            return true;
          }
        )
        .reply(200, {})
        .patch(`/repos/pytorch/pytorch/issues/${issue.number}`, (body) => {
          expect(body.body).toBe(undefined);
          expect(body.state).toEqual("open");
          return true;
        })
        .reply(200, {});

      await singleDisableIssue.updateExistingIssueForFlakyTest(
        octokit,
        issue,
        test
      );

      handleScope(scope);
    });
  });
});
