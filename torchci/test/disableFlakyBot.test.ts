import nock from "nock";
import * as utils from "./utils";
import * as disableFlakyTestBot from "../pages/api/flaky-tests/disable";
import dayjs from "dayjs";
import { handleScope } from "./common";
import { IssueData } from "lib/types";

nock.disableNetConnect();

const flakyTestA = {
  file: "file_a.py",
  invoking_file: "file_a",
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
  file: "file_b.py",
  invoking_file: "file_b",
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
  file: "file_e.py",
  invoking_file: "file_e",
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

const flakyTestAcrossJobA = {
  name: "test_conv1d_vs_scipy_mode_same_cuda_complex64",
  suite: "TestConvolutionNNDeviceTypeCUDA",
  file: "nn/test_convolution.py",
  invoking_file: "nn.test_convolution",
  jobNames: [
    "linux-focal-rocm5.2-py3.8 / test (default, 1, 2, linux.rocm.gpu)",
    "linux-focal-rocm5.2-py3.8 / test (default, 1, 2, linux.rocm.gpu)",
  ],
  jobIds: [9489898216, 9486287115],
  workflowIds: ["3466924095", "3465587581"],
  workflowNames: ["trunk", "trunk"],
  runAttempts: [1, 1],
  eventTimes: ["2022-11-15T02:52:20.311000Z", "2022-11-14T22:30:34.492000Z"],
  branches: ["master", "master"],
};

const nonFlakyTestA = {
  name: "test_a",
  classname: "suite_a",
  filename: "file_a.py",
  flaky: false,
  num_green: 50,
  num_red: 0,
};

const nonFlakyTestZ = {
  name: "test_z",
  classname: "suite_z",
  filename: "file_z.py",
  flaky: false,
  num_green: 50,
  num_red: 0,
};

describe("Disable Flaky Test Bot Across Jobs", () => {
  const octokit = utils.testOctokit();

  beforeEach(() => {});

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("Create new issue", async () => {
    const scope = nock("https://raw.githubusercontent.com")
      .get(`/pytorch/pytorch/main/test/${flakyTestAcrossJobA.file}`)
      .reply(
        200,
        Buffer.from(`# Owner(s): ["module: fft"]\nimport blah;\nrest of file`)
      );
    const scope2 = nock("https://api.github.com")
      .post("/repos/pytorch/pytorch/issues", (body) => {
        expect(body.title).toEqual(
          "DISABLED test_conv1d_vs_scipy_mode_same_cuda_complex64 (__main__.TestConvolutionNNDeviceTypeCUDA)"
        );
        expect(body.labels).toEqual([
          "skipped",
          "module: flaky-tests",
          "module: fft",
          "triaged",
        ]);
        expect(JSON.stringify(body.body)).toContain("Platforms: ");
        return true;
      })
      .reply(200, {});

    await disableFlakyTestBot.handleFlakyTest(flakyTestAcrossJobA, [], octokit);

    handleScope(scope);
    handleScope(scope2);
  });

  test("flaky test associated with an open issue should comment if recent", async () => {
    let flakyTest = { ...flakyTestAcrossJobA };
    flakyTest.eventTimes = [dayjs().subtract(1, "hour").toString()];
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
        title:
          "DISABLED test_conv1d_vs_scipy_mode_same_cuda_complex64 (__main__.TestConvolutionNNDeviceTypeCUDA)",
        html_url: "https://api.github.com/repos/pytorch/pytorch/issues/1",
        state: "open" as "open" | "closed",
        body: "random",
        updated_at: dayjs().toString(),
        author_association: "MEMBER",
      },
    ];

    await disableFlakyTestBot.handleFlakyTest(flakyTest, issues, octokit);

    handleScope(scope);
  });

  test("flaky test associated with an open issue should NOT comment if NOT recent", async () => {
    let flakyTest = { ...flakyTestAcrossJobA };
    flakyTest.eventTimes = [dayjs().subtract(5, "hour").toString()];

    const issues = [
      {
        number: 1,
        title:
          "DISABLED test_conv1d_vs_scipy_mode_same_cuda_complex64 (__main__.TestConvolutionNNDeviceTypeCUDA)",
        html_url: "https://api.github.com/repos/pytorch/pytorch/issues/1",
        state: "open" as "open" | "closed",
        body: "random",
        updated_at: dayjs().toString(),
        author_association: "MEMBER",
      },
    ];

    await disableFlakyTestBot.handleFlakyTest(flakyTest, issues, octokit);
  });

  test("flaky test associated with a closed issue should reopen issue and comment if recent", async () => {
    let flakyTest = { ...flakyTestAcrossJobA };
    flakyTest.eventTimes = [dayjs().subtract(1, "hour").toString()];
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
        title:
          "DISABLED test_conv1d_vs_scipy_mode_same_cuda_complex64 (__main__.TestConvolutionNNDeviceTypeCUDA)",
        html_url: "https://api.github.com/repos/pytorch/pytorch/issues/1",
        state: "closed" as "open" | "closed",
        body: "random",
        updated_at: dayjs().toString(),
        author_association: "MEMBER",
      },
    ];

    await disableFlakyTestBot.handleFlakyTest(flakyTest, issues, octokit);

    handleScope(scope);
  });

  test("flaky test associated with a closed issue should NOT reopen issue and comment if NOT recent", async () => {
    let flakyTest = { ...flakyTestAcrossJobA };
    flakyTest.eventTimes = [dayjs().subtract(5, "hour").toString()];

    const issues = [
      {
        number: 1,
        title:
          "DISABLED test_conv1d_vs_scipy_mode_same_cuda_complex64 (__main__.TestConvolutionNNDeviceTypeCUDA)",
        html_url: "https://api.github.com/repos/pytorch/pytorch/issues/1",
        state: "closed" as "open" | "closed",
        body: "random",
        updated_at: dayjs().toString(),
        author_association: "MEMBER",
      },
    ];

    await disableFlakyTestBot.handleFlakyTest(flakyTest, issues, octokit);
  });
});

describe("Disable Flaky Test Bot Integration Tests", () => {
  const octokit = utils.testOctokit();

  beforeEach(() => {});

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("previously undetected flaky test should create an issue", async () => {
    const scope = nock("https://raw.githubusercontent.com")
      .get(`/pytorch/pytorch/main/test/${flakyTestA.file}`)
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
          "triaged",
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
      .get(`/pytorch/pytorch/main/test/${flakyTestB.file}`)
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
          "triaged",
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
        body: "random",
        updated_at: dayjs().toString(),
        author_association: "MEMBER",
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
        body: "random",
        updated_at: dayjs().toString(),
        author_association: "MEMBER",
      },
    ];

    await disableFlakyTestBot.handleFlakyTest(flakyTestA, issues, octokit);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("comment and close non flaky test", async () => {
    const scope = nock("https://api.github.com")
      .post("/repos/pytorch/pytorch/issues/1/comments", (body) => {
        const comment = JSON.stringify(body.body);
        expect(comment).toContain(
          "Another case of trunk flakiness has been found"
        );
        expect(comment).toContain("Please verify");
        return true;
      })
      .reply(200, {})
      .post("/repos/pytorch/pytorch/issues/1/comments", (body) => {
        const comment = JSON.stringify(body.body);
        expect(comment).toContain(
          "Resolving the issue because the test is not flaky anymore"
        );
        return true;
      })
      .reply(200, {})
      .patch("/repos/pytorch/pytorch/issues/1", (body) => {
        expect(body).toMatchObject({ state: "closed" });
        return true;
      })
      .reply(200, {});

    const issues = [
      {
        number: 1,
        title: "DISABLED test_a (__main__.suite_a)",
        html_url: "https://api.github.com/repos/pytorch/pytorch/issues/1",
        state: "open" as "open" | "closed",
        body: "random",
        updated_at: dayjs()
          .subtract(
            disableFlakyTestBot.NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING + 1,
            "hour"
          )
          .toString(),
        author_association: "MEMBER",
      },
    ];

    await disableFlakyTestBot.handleFlakyTest(flakyTestA, issues, octokit);
    // Close the disabled issue if the test is not flaky anymore
    await disableFlakyTestBot.handleNonFlakyTest(
      nonFlakyTestA,
      issues,
      octokit
    );

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("do not close non flaky test if it's manual updated recently", async () => {
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
        body: "random",
        updated_at: dayjs()
          .subtract(
            disableFlakyTestBot.NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING - 1,
            "hour"
          )
          .toString(),
        author_association: "MEMBER",
      },
    ];

    await disableFlakyTestBot.handleFlakyTest(flakyTestA, issues, octokit);
    // Close the disabled issue if the test is not flaky anymore
    await disableFlakyTestBot.handleNonFlakyTest(
      nonFlakyTestA,
      issues,
      octokit
    );

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });
});

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
    expect(disableFlakyTestBot.filterOutPRFlakyTests(flakyTests)).toEqual(
      expectedFlakyTestsOnTrunk
    );
  });

  test("getTestOwnerLabels: owned test file should return proper module and be triaged", async () => {
    const scope = nock("https://raw.githubusercontent.com/")
      .get(`/pytorch/pytorch/main/test/${flakyTestA.file}`)
      .reply(
        200,
        Buffer.from(`# Owner(s): ["module: fft"]\nimport blah;\nrest of file`)
      );

    const { labels, additionalErrMessage } =
      await disableFlakyTestBot.getTestOwnerLabels(flakyTestA);
    expect(additionalErrMessage).toEqual(undefined);
    expect(labels).toEqual(["module: fft", "triaged"]);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("getTestOwnerLabels: owned test file should route to oncall and NOT be triaged", async () => {
    const scope = nock("https://raw.githubusercontent.com/")
      .get(`/pytorch/pytorch/main/test/${flakyTestA.file}`)
      .reply(
        200,
        Buffer.from(
          `# Owner(s): ["oncall: distributed"]\nimport blah;\nrest of file`
        )
      );

    const { labels } = await disableFlakyTestBot.getTestOwnerLabels(flakyTestA);
    expect(labels).toEqual(["oncall: distributed"]);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("getTestOwnerLabels: un-owned test file should return module: unknown", async () => {
    const scope = nock("https://raw.githubusercontent.com/")
      .get(`/pytorch/pytorch/main/test/${flakyTestA.file}`)
      .reply(
        200,
        Buffer.from(
          `# Owner(s): ["module: unknown"]\nimport blah;\nrest of file`
        )
      );

    const { labels, additionalErrMessage } =
      await disableFlakyTestBot.getTestOwnerLabels(flakyTestA);
    expect(labels).toEqual(["module: unknown"]);
    expect(additionalErrMessage).toEqual(undefined);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("getTestOwnerLabels: ill-formatted file should return module: unknown", async () => {
    const scope = nock("https://raw.githubusercontent.com/")
      .get(`/pytorch/pytorch/main/test/${flakyTestA.file}`)
      .reply(
        200,
        Buffer.from("line1\nline2\nline3\nstill no owners\nline4\nlastline\n")
      );

    const { labels, additionalErrMessage } =
      await disableFlakyTestBot.getTestOwnerLabels(flakyTestA);
    expect(labels).toEqual(["module: unknown"]);
    expect(additionalErrMessage).toEqual(undefined);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
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
      await disableFlakyTestBot.getTestOwnerLabels(flakyTestA);
    expect(labels).toEqual(["module: unknown"]);
    expect(additionalErrMessage).toEqual(
      "Error: Error retrieving file_a.py: 404, file_a: 404"
    );

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
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
      await disableFlakyTestBot.getTestOwnerLabels(flakyTestA);
    expect(labels).toEqual(["module: fft", "triaged"]);
    expect(additionalErrMessage).toEqual(undefined);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
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
      .get(`/pytorch/pytorch/main/test/nn/test_convolution.py`)
      .reply(
        200,
        Buffer.from(`# Owner(s): ["module: fft"]\nimport blah;\nrest of file`)
      );
    const { labels, additionalErrMessage } =
      await disableFlakyTestBot.getTestOwnerLabels(flakyTestAcrossJobA);
    expect(labels).toEqual(["module: fft", "triaged"]);
    expect(additionalErrMessage).toEqual(undefined);

    if (!scope.isDone()) {
      console.error("pending mocks: %j", scope.pendingMocks());
    }
    scope.done();
  });

  test("getTestOwnerLabels: give dynamo and inductor oncall: pt2 label", async () => {
    const test = { ...flakyTestA };
    test.jobNames = ["dynamo linux"];

    let scope = nock("https://raw.githubusercontent.com/")
      .get(`/pytorch/pytorch/main/test/${test.file}`)
      .reply(
        200,
        Buffer.from(`# Owner(s): ["module: fft"]\nimport blah;\nrest of file`)
      );

    let { labels, additionalErrMessage } =
      await disableFlakyTestBot.getTestOwnerLabels(test);
    expect(additionalErrMessage).toEqual(undefined);
    expect(labels).toEqual(["module: fft", "oncall: pt2", "triaged"]);

    handleScope(scope);
  });

  test("getTestOwnerLabels: give dynamo and inductor oncall: pt2 label, unknown owner", async () => {
    const test = { ...flakyTestA };
    test.jobNames = ["inductor linux"];

    let scope = nock("https://raw.githubusercontent.com/")
      .get(`/pytorch/pytorch/main/test/${test.file}`)
      .reply(200, Buffer.from(`import blah;\nrest of file`));

    let { labels, additionalErrMessage } =
      await disableFlakyTestBot.getTestOwnerLabels(test);
    expect(additionalErrMessage).toEqual(undefined);
    expect(labels).toEqual(["module: unknown", "oncall: pt2"]);

    handleScope(scope);
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

  test("getPlatformsAffected: should correctly triage rocm without linux", async () => {
    const workflowJobs = ["pull / whatever-rocm-linux / build"];
    expect(disableFlakyTestBot.getPlatformsAffected(workflowJobs)).toEqual([
      "rocm",
    ]);
  });

  test("getPlatformsAffected: should correctly triage dyanmo and inductor", async () => {
    function expectJobsToDisablePlatforms(jobs: string[], platforms: string[]) {
      expect(disableFlakyTestBot.getPlatformsAffected(jobs)).toEqual(platforms);
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
    expect(disableFlakyTestBot.getIssueBodyForFlakyTest(flakyTestA)).toContain(
      "Platforms: "
    );
  });

  test("getIssueBodyForFlakyTest: should contain correct examples URL", async () => {
    expect(disableFlakyTestBot.getIssueBodyForFlakyTest(flakyTestA)).toContain(
      "https://hud.pytorch.org/flakytest?name=test_a&suite=suite_a"
    );
  });

  test("getIssueBodyForFlakyTest: should contain file info", async () => {
    expect(disableFlakyTestBot.getIssueBodyForFlakyTest(flakyTestA)).toContain(
      "Test file path: `file_a.py`"
    );
  });

  test("filterOutNonFlakyTest: should not contain any flaky tests", async () => {
    const disabledNonFlakyTests = [nonFlakyTestA, nonFlakyTestZ];

    const flakyTests = [flakyTestA, flakyTestB];

    expect(
      disableFlakyTestBot.filterOutNonFlakyTests(
        disabledNonFlakyTests,
        flakyTests
      )
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
      expect(
        await disableFlakyTestBot.dedupFlakyTestIssues(octokit, input)
      ).toEqual([expected]);
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
