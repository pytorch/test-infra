import * as flakyBotUtils from "lib/flakyBot/utils";
import { IssueData } from "lib/types";
import nock from "nock";
import { __forTesting__ as flakyBot } from "pages/api/flaky-tests/disable";
import { handleScope } from "test/common";
import {
  flakyTestA,
  flakyTestAcrossJobA,
  flakyTestB,
  flakyTestE,
  genValidFlakyTest,
  mockGetRawTestFile,
  nonFlakyTestA,
  nonFlakyTestZ,
} from "test/flakyBotTests/flakyBotTestsUtils";
import * as utils from "test/utils";

nock.disableNetConnect();

describe("Disable Flaky Test Bot Utils Unit Tests", () => {
  const octokit = utils.testOctokit();

  beforeEach(() => {});

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("filterOutPRFlakyTests: correctly removes PR only instances", async () => {
    const good1 = genValidFlakyTest({
      branches: ["master", "gh/janeyx99/idk", "master"],
    });
    const good2 = genValidFlakyTest({
      branches: ["main", "gh/janeyx99/idk", "main"],
    });
    const flakyTests = [
      flakyTestA,
      genValidFlakyTest({
        branches: [
          "ciflow/all/12345",
          "ciflow/scheduled/22222",
          "ciflow/all/12345",
        ],
      }),
      good1,
      good2,
      genValidFlakyTest({
        branches: ["quick-fix", "ciflow/scheduled/22222"],
      }),
      flakyTestE,
    ];
    const expectedFlakyTestsOnTrunk = [flakyTestA, good1, good2, flakyTestE];
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
});
