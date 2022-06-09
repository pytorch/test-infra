import nock from "nock";
import * as utils from "./utils";
import * as disableFlakyTestBot from "../pages/api/flaky-tests/disable";

nock.disableNetConnect();

const flakyTestA = {
  file: "file_a",
  suite: "suite_a",
  name: "test_a",
  numGreen: 4,
  numRed: 2,
  workflowIds: ["12345678", "13456789", "14253647"],
  workflowNames: ["trunk", "periodic", "periodic"],
  jobIds: [55443322, 55667788, 56789876],
  jobNames: [
    "win-cpu-vs-2019 / test",
    "win-cuda11.3-vs-2019 / test",
    "win-cuda11.3-vs-2019 / test",
  ],
  branches: ["master", "master", "master"],
};

const flakyTestB = {
  file: "file_b",
  suite: "suite_b",
  name: "test_b",
  numGreen: 4,
  numRed: 2,
  workflowIds: ["12345678", "13456789", "14253647"],
  workflowNames: [
    "win-cpu-vs-2019",
    "periodic-win-cuda11.3-vs-2019",
    "periodic-win-cuda11.3-vs-2019",
  ],
  jobIds: [55443322, 55667788, 56789876],
  jobNames: [
    "win-cpu-vs-2019 / test",
    "win-cuda11.3-vs-2019 / test",
    "win-cuda11.3-vs-2019 / test",
  ],
  branches: ["main", "main", "main"],
};

const flakyTestE = {
  file: "file_e",
  suite: "suite_e",
  name: "test_e",
  numGreen: 4,
  numRed: 2,
  workflowIds: ["12345678", "13456789", "14253647", "15949539"],
  workflowNames: ["pull", "periodic", "trunk", "pull"],
  jobIds: [55443322, 55667788, 56789876, 56677889],
  jobNames: [
    "win-cpu-vs-2019 / test",
    "linux-xenial-cuda11.5-py3 / test",
    "macos-11-x86 / test",
    "win-cpu-vs-2019 / test",
  ],
  branches: ["pr-fix", "master", "master", "another-pr-fx"],
};

describe("Disable Flaky Test Bot Integration Tests", () => {
  const octokit = utils.testOctokit();

  beforeEach(() => {});

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("previously undetected flaky test should create an issue", async () => {
    const scope = nock("https://raw.githubusercontent.com")
      .get(`/pytorch/pytorch/master/test/${flakyTestA.file}.py`)
      .reply(
        200,
        Buffer.from(`# Owner(s): ["module: fft"]\nimport blah;\nrest of file`)
      );
    const scope2 = nock("https://api.github.com")
      .post("/repos/pytorch/pytorch/issues", (body) => {
        expect(body.title).toEqual("DISABLED test_a (__main__.suite_a)");
        expect(body.labels).toEqual([
          "skipped",
          "module: flaky-tests",
          "module: fft",
        ]);
        expect(JSON.stringify(body.body)).toContain("Platforms: ");
        return true;
      })
      .reply(200, {});

    await disableFlakyTestBot.handleFlakyTest(flakyTestA, [], octokit);

    if (!nock.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
      console.error("pending mocks: %j", scope2.pendingMocks());
    }
  });

  test("previously undetected flaky test should create an issue on main", async () => {
    const scope = nock("https://raw.githubusercontent.com")
      .get(`/pytorch/pytorch/master/test/${flakyTestB.file}.py`)
      .reply(
        200,
        Buffer.from(`# Owner(s): ["module: fft"]\nimport blah;\nrest of file`)
      );
    const scope2 = nock("https://api.github.com")
      .post("/repos/pytorch/pytorch/issues", (body) => {
        expect(body.title).toEqual("DISABLED test_b (__main__.suite_b)");
        expect(body.labels).toEqual([
          "skipped",
          "module: flaky-tests",
          "module: fft",
        ]);
        expect(JSON.stringify(body.body)).toContain("Platforms: ");
        return true;
      })
      .reply(200, {});

    await disableFlakyTestBot.handleFlakyTest(flakyTestB, [], octokit);

    if (!nock.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
      console.error("pending mocks: %j", scope2.pendingMocks());
    }
  });

  test("flaky test associated with an open issue should comment", async () => {
    const scope = nock("https://api.github.com")
      .post("/repos/pytorch/pytorch/issues/1/comments", (body) => {
        const comment = JSON.stringify(body.body);
        expect(comment).toContain(
          "Another case of trunk flakiness has been found"
        );
        expect(comment).toContain("Please verify");
        return true;
      })
      .reply(200, {});

    const issues = [
      {
        number: 1,
        title: "DISABLED test_a (__main__.suite_a)",
        html_url: "https://api.github.com/repos/pytorch/pytorch/issues/1",
        state: "open" as "open" | "closed",
      },
    ];

    await disableFlakyTestBot.handleFlakyTest(flakyTestA, issues, octokit);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("flaky test associated with a closed issue should reopen issue and comment", async () => {
    const scope = nock("https://api.github.com")
      .patch("/repos/pytorch/pytorch/issues/1", (body) => {
        expect(body).toMatchObject({ state: "open" });
        return true;
      })
      .reply(200, {})
      .post("/repos/pytorch/pytorch/issues/1/comments", (body) => {
        const comment = JSON.stringify(body.body);
        expect(comment).toContain(
          "Another case of trunk flakiness has been found"
        );
        expect(comment).toContain("Reopening");
        return true;
      })
      .reply(200, {});

    const issues = [
      {
        number: 1,
        title: "DISABLED test_a (__main__.suite_a)",
        html_url: "https://api.github.com/pytorch/pytorch/issues/1",
        state: "closed" as "open" | "closed",
      },
    ];

    await disableFlakyTestBot.handleFlakyTest(flakyTestA, issues, octokit);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });
});

describe("Disable Flaky Test Bot Unit Tests", () => {
  beforeEach(() => {});

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("filterOutPRFlakyTests: correctly filters and updates flaky test list", async () => {
    const flakyTests = [
      flakyTestA,
      {
        file: "file_b",
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
        file: "file_c",
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
        file: "file_d",
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
        file: "file_c",
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
    expect(disableFlakyTestBot.filterOutPRFlakyTests(flakyTests)).toEqual(
      expectedFlakyTestsOnTrunk
    );
  });

  test("getTestOwnerLabels: owned test file should return proper module", async () => {
    const scope = nock("https://raw.githubusercontent.com/")
      .get(`/pytorch/pytorch/master/test/${flakyTestA.file}.py`)
      .reply(
        200,
        Buffer.from(`# Owner(s): ["module: fft"]\nimport blah;\nrest of file`)
      );

    const labels = await disableFlakyTestBot.getTestOwnerLabels(
      flakyTestA.file
    );
    expect(labels).toEqual(["module: fft"]);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("getTestOwnerLabels: un-owned test file should return module: unknown", async () => {
    const scope = nock("https://raw.githubusercontent.com/")
      .get(`/pytorch/pytorch/master/test/${flakyTestA.file}.py`)
      .reply(
        200,
        Buffer.from(
          `# Owner(s): ["module: unknown"]\nimport blah;\nrest of file`
        )
      );

    const labels = await disableFlakyTestBot.getTestOwnerLabels(
      flakyTestA.file
    );
    expect(labels).toEqual(["module: unknown"]);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("getTestOwnerLabels: ill-formatted file should return module: unknown", async () => {
    const scope = nock("https://raw.githubusercontent.com/")
      .get(`/pytorch/pytorch/master/test/${flakyTestA.file}.py`)
      .reply(
        200,
        Buffer.from("line1\nline2\nline3\nstill no owners\nline4\nlastline\n")
      );

    const labels = await disableFlakyTestBot.getTestOwnerLabels(
      flakyTestA.file
    );
    expect(labels).toEqual(["module: unknown"]);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("getLatestTrunkJobURL: should return URL of last trunk job if it exists", async () => {
    expect(disableFlakyTestBot.getLatestTrunkJobURL(flakyTestE)).toEqual(
      "https://github.com/pytorch/pytorch/runs/56789876"
    );
  });

  test("getLatestTrunkJobURL: should return URL of last job if no trunk instance exists", async () => {
    expect(disableFlakyTestBot.getLatestTrunkJobURL(flakyTestA)).toEqual(
      "https://github.com/pytorch/pytorch/runs/56789876"
    );
  });

  test("getIssueTitle: test suite in subclass should not have __main__", async () => {
    expect(
      disableFlakyTestBot.getIssueTitle(
        "test_cool_op_cpu",
        "jit.async.SpecialSuite"
      )
    ).toEqual("DISABLED test_cool_op_cpu (jit.async.SpecialSuite)");
  });

  test("getIssueTitle: test suite not in subclass should be prefixed with __main__", async () => {
    expect(
      disableFlakyTestBot.getIssueTitle("test_cool_op_cpu", "TestLinAlgCPU")
    ).toEqual("DISABLED test_cool_op_cpu (__main__.TestLinAlgCPU)");
  });

  test("getWorkflowJobNames: should zip the workflow and job names of a test", async () => {
    expect(disableFlakyTestBot.getWorkflowJobNames(flakyTestA)).toEqual([
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
    expect(disableFlakyTestBot.getPlatformsAffected(workflowJobNames)).toEqual([
      "linux",
    ]);
  });

  test("getPlatformsAffected: should correctly triage workflows of various platforms", async () => {
    const workflowJobs = disableFlakyTestBot.getWorkflowJobNames(flakyTestE);
    expect(disableFlakyTestBot.getPlatformsAffected(workflowJobs)).toEqual([
      "linux",
      "mac",
      "macos",
      "win",
    ]);
  });

  test("getIssueBodyForFlakyTest: should contain Platforms line", async () => {
    expect(disableFlakyTestBot.getIssueBodyForFlakyTest(flakyTestA)).toContain(
      "Platforms: "
    );
  });

  test("getIssueBodyForFlakyTest: should contain correct examples URL", async () => {
    expect(disableFlakyTestBot.getIssueBodyForFlakyTest(flakyTestA)).toContain(
      "https://hud.pytorch.org/flakytest?name=test_a&suite=suite_a&file=file_a"
    );
  });
});
