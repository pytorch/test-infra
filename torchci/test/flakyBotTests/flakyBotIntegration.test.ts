import dayjs from "dayjs";
import { handleNonFlakyTest } from "lib/flakyBot/singleDisableIssue";
import { NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING } from "lib/flakyBot/utils";
import { IssueData } from "lib/types";
import nock from "nock";
import { handleFlakyTest } from "pages/api/flaky-tests/disable";
import { handleScope } from "test/common";
import {
  flakyTestA,
  flakyTestAcrossJobA,
  flakyTestB,
  mockGetRawTestFile,
  nonFlakyTestA,
} from "test/flakyBotTests/flakyBotTestsUtils";
import * as utils from "test/utils";

nock.disableNetConnect();

describe("Disable Flaky Test Bot Across Jobs", () => {
  const octokit = utils.testOctokit();

  beforeEach(() => {});

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("Create new issue", async () => {
    const scope = mockGetRawTestFile(
      flakyTestAcrossJobA.file,
      `# Owner(s): ["module: fft"]\nimport blah;\nrest of file`
    );
    const scope2 = utils.mockCreateIssue(
      "pytorch/pytorch",
      "DISABLED test_conv1d_vs_scipy_mode_same_cuda_complex64 (__main__.TestConvolutionNNDeviceTypeCUDA)",
      ["Platforms: "],
      [
        "skipped",
        "module: flaky-tests",
        "module: fft",
        "module: rocm",
        "triaged",
      ]
    );

    await handleFlakyTest(flakyTestAcrossJobA, [], octokit);

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
        expect(comment).toContain("appears to contain");
        expect(comment).toContain("Either the change didn't propogate");
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
        labels: [],
      },
    ];

    await handleFlakyTest(flakyTest, issues, octokit);

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
        labels: [],
      },
    ];

    await handleFlakyTest(flakyTest, issues, octokit);
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
        labels: [],
      },
    ];

    await handleFlakyTest(flakyTest, issues, octokit);

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
        labels: [],
      },
    ];

    await handleFlakyTest(flakyTest, issues, octokit);
  });
});

describe("Disable Flaky Test Bot Integration Tests", () => {
  const octokit = utils.testOctokit();

  beforeEach(() => {});

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("previously undetected flaky test should create an issue", async () => {
    const scope = mockGetRawTestFile(
      flakyTestA.file,
      `# Owner(s): ["module: fft"]\nimport blah;\nrest of file`
    );
    const scope2 = utils.mockCreateIssue(
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
    );

    await handleFlakyTest(flakyTestA, [], octokit);

    handleScope(scope);
    handleScope(scope2);
  });

  test("previously undetected flaky test should create an issue on main", async () => {
    const scope = mockGetRawTestFile(
      flakyTestB.file,
      `# Owner(s): ["module: fft"]\nimport blah;\nrest of file`
    );
    const scope2 = utils.mockCreateIssue(
      "pytorch/pytorch",
      "DISABLED test_b (__main__.suite_b)",
      ["Platforms:"],
      [
        "skipped",
        "module: flaky-tests",
        "module: fft",
        "module: windows",
        "triaged",
      ]
    );

    await handleFlakyTest(flakyTestB, [], octokit);

    handleScope(scope);
    handleScope(scope2);
  });

  test("flaky test associated with an open issue should comment", async () => {
    const scope = nock("https://api.github.com")
      .post("/repos/pytorch/pytorch/issues/1/comments", (body) => {
        const comment = JSON.stringify(body.body);
        expect(comment).toContain(
          "Another case of trunk flakiness has been found"
        );
        expect(comment).toContain("Either the change didn't propogate");
        return true;
      })
      .reply(200, {});

    const issues: IssueData[] = [
      {
        number: 1,
        title: "DISABLED test_a (__main__.suite_a)",
        html_url: "https://api.github.com/repos/pytorch/pytorch/issues/1",
        state: "open" as "open" | "closed",
        body: "random",
        updated_at: dayjs().toString(),
        author_association: "MEMBER",
        labels: [],
      },
    ];

    await handleFlakyTest(flakyTestA, issues, octokit);

    handleScope(scope);
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

    const issues: IssueData[] = [
      {
        number: 1,
        title: "DISABLED test_a (__main__.suite_a)",
        html_url: "https://api.github.com/pytorch/pytorch/issues/1",
        state: "closed" as "open" | "closed",
        body: "random",
        updated_at: dayjs().toString(),
        author_association: "MEMBER",
        labels: [],
      },
    ];

    await handleFlakyTest(flakyTestA, issues, octokit);

    handleScope(scope);
  });

  test("comment and close non flaky test", async () => {
    const scope = nock("https://api.github.com")
      .post("/repos/pytorch/pytorch/issues/1/comments", (body) => {
        const comment = JSON.stringify(body.body);
        expect(comment).toContain(
          "Another case of trunk flakiness has been found"
        );
        expect(comment).toContain("Either the change didn't propogate");
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

    const issues: IssueData[] = [
      {
        number: 1,
        title: "DISABLED test_a (__main__.suite_a)",
        html_url: "https://api.github.com/repos/pytorch/pytorch/issues/1",
        state: "open" as "open" | "closed",
        body: "random",
        updated_at: dayjs()
          .subtract(NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING + 1, "hour")
          .toString(),
        author_association: "MEMBER",
        labels: [],
      },
    ];

    await handleFlakyTest(flakyTestA, issues, octokit);
    // Close the disabled issue if the test is not flaky anymore
    await handleNonFlakyTest(nonFlakyTestA, issues, octokit);

    handleScope(scope);
  });

  test("do not close non flaky test if it's manual updated recently", async () => {
    const scope = nock("https://api.github.com")
      .post("/repos/pytorch/pytorch/issues/1/comments", (body) => {
        const comment = JSON.stringify(body.body);
        expect(comment).toContain(
          "Another case of trunk flakiness has been found"
        );
        expect(comment).toContain("Either the change didn't propogate");
        return true;
      })
      .reply(200, {});

    const issues: IssueData[] = [
      {
        number: 1,
        title: "DISABLED test_a (__main__.suite_a)",
        html_url: "https://api.github.com/repos/pytorch/pytorch/issues/1",
        state: "open" as "open" | "closed",
        body: "random",
        updated_at: dayjs()
          .subtract(NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING - 1, "hour")
          .toString(),
        author_association: "MEMBER",
        labels: [],
      },
    ];

    await handleFlakyTest(flakyTestA, issues, octokit);
    // Close the disabled issue if the test is not flaky anymore
    await handleNonFlakyTest(nonFlakyTestA, issues, octokit);

    handleScope(scope);
  });
});
