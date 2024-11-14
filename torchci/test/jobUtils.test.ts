import { TIME_0 } from "lib/bot/utils";
import { isSameAuthor } from "lib/drciUtils";
import {
  BasicJobData,
  IssueData,
  PRandJobs,
  RecentWorkflowsData,
} from "lib/types";
import nock from "nock";
import * as getAuthors from "../lib/getAuthors";
import {
  getDisabledTestIssues,
  isDisabledTest,
  isDisabledTestMentionedInPR,
  isFailureFromPrevMergeCommit,
  isRecentlyCloseDisabledTest,
  isSameContext,
  isSameFailure,
  removeCancelledJobAfterRetry,
  removeJobNameSuffix,
} from "../lib/jobUtils";
import { getDummyJob } from "./drci.test";

nock.disableNetConnect();

describe("Test various job utils", () => {
  beforeEach(() => {});

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("no input", () => {
    expect(removeJobNameSuffix("")).toStrictEqual("");
  });

  test("various job names", () => {
    expect(
      removeJobNameSuffix(
        "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)"
      )
    ).toStrictEqual("linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default)");
    expect(
      removeJobNameSuffix(
        "android-emulator-build-test / build-and-test (default, 1, 1, ubuntu-20.04-16x)"
      )
    ).toStrictEqual("android-emulator-build-test / build-and-test (default)");
    expect(
      removeJobNameSuffix("linux-focal-rocm5.4.2-py3.8 / build")
    ).toStrictEqual("linux-focal-rocm5.4.2-py3.8 / build");
    expect(
      removeJobNameSuffix("libtorch-cpu-shared-with-deps-release-build")
    ).toStrictEqual("libtorch-cpu-shared-with-deps-release-build");
    expect(
      removeJobNameSuffix(
        "libtorch-cpu-shared-with-deps-pre-cxx11-build / build"
      )
    ).toStrictEqual("libtorch-cpu-shared-with-deps-pre-cxx11-build / build");
    expect(
      removeJobNameSuffix("manywheel-py3_8-cuda11_8-test / test")
    ).toStrictEqual("manywheel-py3_8-cuda11_8-test / test");
    expect(removeJobNameSuffix("lintrunner / linux-job")).toStrictEqual(
      "lintrunner / linux-job"
    );
    expect(
      removeJobNameSuffix("Test `run_test.py` is usable without boto3/rockset")
    ).toStrictEqual("Test `run_test.py` is usable without boto3/rockset");
  });

  test("test isSameAuthor", async () => {
    const job: RecentWorkflowsData = getDummyJob({
      head_sha: "123",
      // The rest doesn't matter
    });
    const failure: RecentWorkflowsData = getDummyJob({
      head_sha: "456",
      // The rest doesn't matter
    });

    const mock = jest.spyOn(getAuthors, "getAuthors");
    mock.mockImplementation((records: RecentWorkflowsData[]) =>
      Promise.resolve({
        "123": {
          email: "mock@user.com",
          commit_username: "",
          pr_username: "",
        },
        "456": {
          email: "mock@user.com",
          commit_username: "",
          pr_username: "",
        },
      })
    );
    // Same email
    expect(await isSameAuthor(job, failure)).toEqual(true);

    mock.mockImplementation((records: RecentWorkflowsData[]) =>
      Promise.resolve({
        "123": {
          email: "",
          commit_username: "mock",
          pr_username: "",
        },
        "456": {
          email: "",
          commit_username: "mock",
          pr_username: "",
        },
      })
    );
    // Same commit username
    expect(await isSameAuthor(job, failure)).toEqual(true);

    mock.mockImplementation((records: RecentWorkflowsData[]) =>
      Promise.resolve({
        "123": {
          email: "",
          commit_username: "",
          pr_username: "mock",
        },
        "456": {
          email: "",
          commit_username: "",
          pr_username: "mock",
        },
      })
    );
    // Same PR username
    expect(await isSameAuthor(job, failure)).toEqual(true);

    mock.mockImplementation((records: RecentWorkflowsData[]) =>
      Promise.resolve({
        "123": {
          email: "mock@user.com",
          commit_username: "",
          pr_username: "",
        },
        "456": {
          email: "diff@user.com",
          commit_username: "",
          pr_username: "",
        },
      })
    );
    // Different email
    expect(await isSameAuthor(job, failure)).toEqual(false);

    mock.mockImplementation((records: RecentWorkflowsData[]) =>
      Promise.resolve({
        "123": {
          email: "",
          commit_username: "mock",
          pr_username: "",
        },
        "456": {
          email: "",
          commit_username: "diff",
          pr_username: "",
        },
      })
    );
    // Different commit username
    expect(await isSameAuthor(job, failure)).toEqual(false);

    mock.mockImplementation((records: RecentWorkflowsData[]) =>
      Promise.resolve({
        "123": {
          email: "",
          commit_username: "",
          pr_username: "mock",
        },
        "456": {
          email: "",
          commit_username: "",
          pr_username: "diff",
        },
      })
    );
    // Different pr username
    expect(await isSameAuthor(job, failure)).toEqual(false);
  });

  test("test isSameFailure", () => {
    const jobA: RecentWorkflowsData = getDummyJob({
      id: 1,
      name: "",
      html_url: "A",
      head_sha: "A",
      failure_captures: [],
      conclusion: "failure",
    });
    const jobB: RecentWorkflowsData = getDummyJob({
      id: 1,
      name: "",
      html_url: "B",
      head_sha: "B",
      failure_captures: [],
      conclusion: "failure",
    });

    // Missing job name
    expect(isSameFailure(jobA, jobB)).toEqual(false);

    jobA.name =
      "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)";
    jobB.name =
      "android-emulator-build-test / build-and-test (default, 1, 1, ubuntu-20.04-16x)";
    // Different job names
    expect(isSameFailure(jobA, jobB)).toEqual(false);

    jobA.name =
      "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)";
    jobA.conclusion = "cancelled";
    jobB.name =
      "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)";
    jobB.conclusion = "failure";
    // Different conclusions
    expect(isSameFailure(jobA, jobB)).toEqual(false);

    jobA.name =
      "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)";
    jobA.conclusion = "cancelled";
    jobA.failure_captures = ["A"];
    jobB.name =
      "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)";
    jobB.conclusion = "failure";
    jobB.failure_captures = ["B"];
    // Different failures
    expect(isSameFailure(jobA, jobB)).toEqual(false);

    jobA.name =
      "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)";
    jobA.conclusion = "failure";
    jobA.failure_captures = ["ERROR"];
    jobB.name =
      "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 2, 5, linux.g5.4xlarge.nvidia.gpu, unstable)";
    jobB.conclusion = "failure";
    jobB.failure_captures = ["ERROR"];
    // Same failure
    expect(isSameFailure(jobA, jobB)).toEqual(true);
  });

  test("test isSameContext", () => {
    const jobA: RecentWorkflowsData = getDummyJob({
      id: 1,
      name: "Testing",
      html_url: "A",
      head_sha: "A",
      failure_captures: ["Process completed with exit code 1"],
      failure_context: [],
      conclusion: "failure",
      completed_at: "A",
    });
    const jobB: RecentWorkflowsData = getDummyJob({
      id: 2,
      name: "Testing",
      html_url: "B",
      head_sha: "B",
      failure_captures: ["Process completed with exit code 1"],
      failure_context: [],
      conclusion: "failure",
      completed_at: "B",
    });

    // If both jobs don't have any context, consider them the same
    expect(isSameContext(jobA, jobB)).toEqual(true);
    expect(isSameFailure(jobA, jobB)).toEqual(true);

    jobB.failure_context = [];
    // Empty context is the same as having no context
    expect(isSameContext(jobA, jobB)).toEqual(true);
    expect(isSameFailure(jobA, jobB)).toEqual(true);

    jobB.failure_context = ["FOOBAR"];
    // If only one job has context, the other doesn't, they are not the same
    expect(isSameContext(jobA, jobB)).toEqual(false);
    expect(isSameFailure(jobA, jobB)).toEqual(false);

    jobA.failure_context = ["FOO"];
    jobB.failure_context = ["BAR"];
    // Same error but have different context
    expect(isSameContext(jobA, jobB)).toEqual(false);
    expect(isSameFailure(jobA, jobB)).toEqual(false);

    jobA.failure_context = ["FOO"];
    jobB.failure_context = ["FOO"];
    // Same error with same context
    expect(isSameContext(jobA, jobB)).toEqual(true);
    expect(isSameFailure(jobA, jobB)).toEqual(true);

    jobA.failure_context = ["FOO --shard 1 2"];
    jobB.failure_context = ["FOO --shard 2 2"];
    // Same error with similar context
    expect(isSameContext(jobA, jobB)).toEqual(true);
    expect(isSameFailure(jobA, jobB)).toEqual(true);
  });

  test("test isFailureFromPrevMergeCommit", () => {
    const failure: RecentWorkflowsData = getDummyJob({
      id: 2,
      name: "Testing",
      html_url: "B",
      head_sha: "B",
      failure_captures: ["whatever"],
      conclusion: "failure",
    });

    failure.head_branch = "whatever";
    // Not a failure from trunk, it couldn't come from a previous merge commit
    // of a reverted PR
    expect(isFailureFromPrevMergeCommit(failure, [])).toEqual(false);

    failure.head_branch = "main";
    // No merge commit, PR is not yet merged
    expect(isFailureFromPrevMergeCommit(failure, [])).toEqual(false);

    // No matching commit SHA
    expect(isFailureFromPrevMergeCommit(failure, ["NO MATCH"])).toEqual(false);

    // Matching SHA, this is a failure from a merge commit
    expect(isFailureFromPrevMergeCommit(failure, ["B"])).toEqual(true);
  });

  test("test removeCancelledJobAfterRetry", async () => {
    const jobs: BasicJobData[] = [
      // Basic case
      {
        name: "linux-binary-manywheel / manywheel-py3_10-cuda11_8-test",
        conclusion: "cancelled",
        time: "2023-09-12T17:42:42.746515Z",
      },
      {
        name: "linux-binary-manywheel / manywheel-py3_10-cuda11_8-test / test",
        conclusion: "success",
        time: "2023-09-12T20:00:01.494101Z",
      },

      // Multiple matches after retrying
      {
        name: "pull / linux-docs",
        conclusion: "cancelled",
        time: "2023-08-23T08:57:45.242030Z",
      },
      {
        name: "pull / linux-docs / build-docs-cpp-false",
        conclusion: "success",
        time: "2023-08-23T09:11:17.117449Z",
      },
      {
        name: "pull / linux-docs / build-docs-functorch-false",
        conclusion: "success",
        time: "2023-08-23T09:11:18.699641Z",
      },
      {
        name: "pull / linux-docs / build-docs-python-false",
        conclusion: "success",
        time: "2023-08-23T09:11:18.505274Z",
      },

      // The retry was record a split-second earlier
      {
        name: "Labeler",
        conclusion: "cancelled",
        time: "2023-08-23T08:57:20.619274Z",
      },
      {
        name: "Labeler",
        conclusion: "success",
        time: "2023-08-23T08:57:20.499395Z",
      },

      // One retry was record a split-second earlier and there are more
      // than one of them
      {
        name: "bc_linter",
        conclusion: "success",
        time: "2023-09-14T23:44:39.303620Z",
      },
      {
        name: "bc_linter",
        conclusion: "cancelled",
        time: "2023-09-14T23:44:17.259156Z",
      },
      {
        name: "bc_linter",
        conclusion: "success",
        time: "2023-09-12T18:26:22.734555Z",
      },
      {
        name: "bc_linter",
        conclusion: "success",
        time: "2023-09-12T16:45:45.773260Z",
      },

      // One match, keep the record
      {
        name: "trunk / linux-focal-rocm5.6-py3.8",
        conclusion: "cancelled",
        time: "2023-09-12T17:42:42.746515Z",
      },

      // With shards
      {
        name: "pull / linux-focal-py3.8-clang10",
        conclusion: "cancelled",
        time: "2023-08-23T08:57:41.259961Z",
      },
      {
        name: "pull / linux-focal-py3.8-clang10 / build",
        conclusion: "success",
        time: "2023-08-23T08:57:41.117724Z",
      },
      {
        name: "pull / linux-focal-py3.8-clang10 / build",
        conclusion: "cancelled",
        time: "2023-08-23T08:57:27.732608Z",
      },
      {
        name: "pull / linux-focal-py3.8-clang10 / test (default, 1, 3, linux.2xlarge)",
        conclusion: "success",
        time: "2023-08-23T09:10:02.173355Z",
      },
      {
        name: "pull / linux-focal-py3.8-clang10 / test (default, 2, 3, linux.2xlarge)",
        conclusion: "success",
        time: "2023-08-23T09:10:01.259562Z",
      },
      {
        name: "pull / linux-focal-py3.8-clang10 / test (default, 3, 3, linux.2xlarge)",
        conclusion: "cancelled",
        time: "2023-08-23T09:10:01.259562Z",
      },

      // Do not match with other jobs with similar prefix
      {
        name: "pull / linux-jammy-py3.8-gcc11 / build",
        conclusion: "success",
        time: "2023-08-23T08:57:27.732608Z",
      },
      {
        name: "pull / linux-jammy-py3.8-gcc11 / build",
        conclusion: "cancelled",
        time: "2023-08-23T09:10:01.259562Z",
      },
      {
        name: "pull / linux-jammy-py3.8-gcc11-mobile-lightweight-dispatch-build / build",
        conclusion: "success",
        // Set the timestamp here to be after the previous timestamp indicating that this
        // job runs after pull / linux-jammy-py3.8-gcc11 / build. The latter should not be
        // removed from the list
        time: "2023-08-23T09:15:01.259562Z",
      },
      {
        name: "pull / linux-jammy-py3.8-gcc11-no-ops / build",
        conclusion: "success",
        time: "2023-08-23T09:15:01.259562Z",
      },
      {
        name: "pull / linux-jammy-py3.8-gcc11-no-ops / build",
        conclusion: "cancelled",
        time: "2023-08-23T08:57:27.732608Z",
      },
      {
        name: "pull / linux-jammy-py3.8-gcc11-pch / build",
        conclusion: "success",
        time: "2023-08-23T08:57:27.732608Z",
      },
    ];

    const results = removeCancelledJobAfterRetry(jobs);
    expect(new Set(results)).toEqual(
      new Set([
        // Basic case
        {
          name: "linux-binary-manywheel / manywheel-py3_10-cuda11_8-test / test",
          conclusion: "success",
          time: "2023-09-12T20:00:01.494101Z",
        },

        // Multiple matches after retrying
        {
          name: "pull / linux-docs / build-docs-cpp-false",
          conclusion: "success",
          time: "2023-08-23T09:11:17.117449Z",
        },
        {
          name: "pull / linux-docs / build-docs-functorch-false",
          conclusion: "success",
          time: "2023-08-23T09:11:18.699641Z",
        },
        {
          name: "pull / linux-docs / build-docs-python-false",
          conclusion: "success",
          time: "2023-08-23T09:11:18.505274Z",
        },

        // The retry was record a split-second earlier
        {
          name: "Labeler",
          conclusion: "success",
          time: "2023-08-23T08:57:20.499395Z",
        },

        // One retry was record a split-second earlier and there are more
        // than one of them
        {
          name: "bc_linter",
          conclusion: "success",
          time: "2023-09-14T23:44:39.303620Z",
        },

        // One match, keep the record
        {
          name: "trunk / linux-focal-rocm5.6-py3.8",
          conclusion: "cancelled",
          time: "2023-09-12T17:42:42.746515Z",
        },

        // With shards
        {
          name: "pull / linux-focal-py3.8-clang10 / build",
          conclusion: "success",
          time: "2023-08-23T08:57:41.117724Z",
        },
        {
          name: "pull / linux-focal-py3.8-clang10 / test (default, 1, 3, linux.2xlarge)",
          conclusion: "success",
          time: "2023-08-23T09:10:02.173355Z",
        },
        {
          name: "pull / linux-focal-py3.8-clang10 / test (default, 2, 3, linux.2xlarge)",
          conclusion: "success",
          time: "2023-08-23T09:10:01.259562Z",
        },
        {
          name: "pull / linux-focal-py3.8-clang10 / test (default, 3, 3, linux.2xlarge)",
          conclusion: "cancelled",
          time: "2023-08-23T09:10:01.259562Z",
        },

        // Do not match with other jobs with similar prefix
        {
          name: "pull / linux-jammy-py3.8-gcc11 / build",
          conclusion: "cancelled",
          time: "2023-08-23T09:10:01.259562Z",
        },
        {
          name: "pull / linux-jammy-py3.8-gcc11-mobile-lightweight-dispatch-build / build",
          conclusion: "success",
          time: "2023-08-23T09:15:01.259562Z",
        },
        {
          name: "pull / linux-jammy-py3.8-gcc11-no-ops / build",
          conclusion: "success",
          time: "2023-08-23T09:15:01.259562Z",
        },
        {
          name: "pull / linux-jammy-py3.8-gcc11-pch / build",
          conclusion: "success",
          time: "2023-08-23T08:57:27.732608Z",
        },
      ])
    );
  });

  test("test isDisabledTest", async () => {
    const mockIssue: IssueData = {
      state: "open",
      number: 123,
      title: "",
      body: "",
      updated_at: "",
      author_association: "",
      html_url: "",
      labels: [],
    };

    expect(isDisabledTest([])).toEqual(false);
    expect(
      isDisabledTest([
        {
          ...mockIssue,
          state: "closed",
        },
      ])
    ).toEqual(false);
    expect(
      isDisabledTest([
        {
          ...mockIssue,
          state: "open",
        },
      ])
    ).toEqual(true);
    // Hypothetical case where there are more than one matching disabled test issues,
    // the test is disabled as long as one of them is open
    expect(
      isDisabledTest([
        {
          ...mockIssue,
          state: "open",
        },
        {
          ...mockIssue,
          state: "closed",
          number: 456,
        },
      ])
    ).toEqual(true);
  });

  test("test isDisabledTestMentionedInPR", async () => {
    const prInfo: PRandJobs = {
      head_sha: "",
      head_sha_timestamp: "",
      pr_number: 12345,
      jobs: [],
      merge_base: "",
      merge_base_date: "",
      owner: "pytorch",
      repo: "pytorch",
      title: "A mock PR",
      // Only the following fields matter in this test
      body: "Anything goes. Fixes #666. Fixes https://github.com/pytorch/pytorch/issues/555",
      shas: [
        {
          sha: "SHA",
          title: "Anything goes",
        },
        {
          sha: "SHA",
          title: "Anything goes. Fixes #777",
        },
      ],
    };
    const mockIssue: IssueData = {
      state: "open",
      number: 123,
      title: "",
      body: "",
      updated_at: "",
      author_association: "",
      html_url: "",
      labels: [],
    };

    expect(isDisabledTestMentionedInPR([], prInfo)).toEqual(false);
    // Not mention anywhere
    expect(
      isDisabledTestMentionedInPR(
        [
          {
            ...mockIssue,
            state: "closed",
          },
        ],
        prInfo
      )
    ).toEqual(false);
    expect(
      isDisabledTestMentionedInPR(
        [
          {
            ...mockIssue,
            state: "open",
          },
        ],
        prInfo
      )
    ).toEqual(false);

    // Mention in PR body
    expect(
      isDisabledTestMentionedInPR(
        [
          {
            ...mockIssue,
            state: "closed",
            number: 666,
          },
        ],
        prInfo
      )
    ).toEqual(true);
    expect(
      isDisabledTestMentionedInPR(
        [
          {
            ...mockIssue,
            state: "open",
            number: 666,
          },
        ],
        prInfo
      )
    ).toEqual(true);

    // Another one mention in PR body
    expect(
      isDisabledTestMentionedInPR(
        [
          {
            ...mockIssue,
            state: "closed",
            number: 555,
          },
        ],
        prInfo
      )
    ).toEqual(true);
    expect(
      isDisabledTestMentionedInPR(
        [
          {
            ...mockIssue,
            state: "open",
            number: 555,
          },
        ],
        prInfo
      )
    ).toEqual(true);

    // Mention in PR one of the PR commit
    expect(
      isDisabledTestMentionedInPR(
        [
          {
            ...mockIssue,
            state: "closed",
            number: 777,
          },
        ],
        prInfo
      )
    ).toEqual(true);
    expect(
      isDisabledTestMentionedInPR(
        [
          {
            ...mockIssue,
            state: "open",
            number: 777,
          },
        ],
        prInfo
      )
    ).toEqual(true);

    // Just one issue is mentioned in the list
    expect(
      isDisabledTestMentionedInPR(
        [
          {
            ...mockIssue,
            state: "open",
            number: 666,
          },
          {
            ...mockIssue,
            state: "open",
            number: 123,
          },
        ],
        prInfo
      )
    ).toEqual(true);
    expect(
      isDisabledTestMentionedInPR(
        [
          {
            ...mockIssue,
            state: "open",
            number: 666,
          },
          {
            ...mockIssue,
            state: "closed",
            number: 123,
          },
        ],
        prInfo
      )
    ).toEqual(true);
  });

  test("test isRecentlyCloseDisabledTest", async () => {
    const mockIssue: IssueData = {
      state: "open",
      number: 123,
      title: "",
      body: "",
      updated_at: "",
      author_association: "",
      html_url: "",
      labels: [],
    };

    // At least one of the issue is still open
    expect(
      isRecentlyCloseDisabledTest(
        [
          {
            ...mockIssue,
            state: "open",
            updated_at: "2024-05-05T00:00:00Z",
          },
        ],
        "2024-05-06T00:00:00Z"
      )
    ).toEqual(false);
    expect(
      isRecentlyCloseDisabledTest(
        [
          {
            ...mockIssue,
            state: "open",
            updated_at: "2024-05-05T00:00:00Z",
          },
          {
            ...mockIssue,
            state: "closed",
            number: 666,
            updated_at: "2024-05-04T00:00:00Z",
          },
        ],
        "2024-05-06T00:00:00Z"
      )
    ).toEqual(false);

    // The issue is close before the base commit date
    expect(
      isRecentlyCloseDisabledTest(
        [
          {
            ...mockIssue,
            state: "closed",
            updated_at: "2024-05-05T00:00:00Z",
          },
          {
            ...mockIssue,
            state: "closed",
            number: 666,
            updated_at: "2024-05-04T00:00:00Z",
          },
        ],
        "2024-05-06T00:00:00Z"
      )
    ).toEqual(false);

    // The issue is close after the base commit date
    expect(
      isRecentlyCloseDisabledTest(
        [
          {
            ...mockIssue,
            state: "closed",
            updated_at: "2024-05-06T00:30:00Z",
          },
          {
            ...mockIssue,
            state: "closed",
            number: 666,
            updated_at: "2024-05-06T01:00:00Z",
          },
        ],
        "2024-05-06T00:00:00Z"
      )
    ).toEqual(true);
  });

  test("test getDisabledTestIssues", async () => {
    const mockJob: RecentWorkflowsData = getDummyJob({
      id: 0,
      completed_at: TIME_0,
      html_url: "",
      head_sha: "",
      failure_captures: [
        "test_cpp_extensions_open_device_registration.py::TestCppExtensionOpenRgistration::test_open_device_registration",
      ],
      name: "pull / linux-focal-py3.11-clang10 / test (default, 1, 3, linux.2xlarge)",
    });
    const mockIssue: IssueData = {
      number: 100152,
      state: "open",
      title:
        "DISABLED test_open_device_registration (__main__.TestCppExtensionOpenRgistration)",
      body: "Platforms: linux, win, mac",
      updated_at: "2024-05-06T00:30:00Z",
      author_association: "",
      html_url: "",
      labels: [],
    };

    // Invalid input should return nothing
    expect(
      getDisabledTestIssues(
        {
          ...mockJob,
          failure_captures: [],
        },
        []
      )
    ).toEqual([]);

    // Having no disabled test issue
    expect(getDisabledTestIssues(mockJob, [])).toEqual([]);

    // Not matching the failure regex
    expect(
      getDisabledTestIssues(
        {
          ...mockJob,
          failure_captures: ["Not a failed test"],
        },
        [mockIssue]
      )
    ).toEqual([]);

    // Not matching test case
    expect(
      getDisabledTestIssues(
        {
          ...mockJob,
          failure_captures: [
            "test_cpp_extensions_open_device_registration.py::TestCppExtensionOpenRgistration::test_open_device_registration_no_match",
          ],
        },
        [mockIssue]
      )
    ).toEqual([]);

    // Not matching test class
    expect(
      getDisabledTestIssues(
        {
          ...mockJob,
          failure_captures: [
            "test_cpp_extensions_open_device_registration.py::TestCppExtensionOpenRgistrationNoMatch::test_open_device_registration",
          ],
        },
        [mockIssue]
      )
    ).toEqual([]);

    // No platforms
    expect(
      getDisabledTestIssues(mockJob, [
        {
          ...mockIssue,
          body: "Nothing is specified here.  This means that the test is disabled everywhere",
        },
      ])
    ).toEqual([
      {
        ...mockIssue,
        body: "Nothing is specified here.  This means that the test is disabled everywhere",
      },
    ]);

    // Match a disable test issue
    expect(
      getDisabledTestIssues(mockJob, [
        {
          ...mockIssue,
          body: "Platforms: linux, mac",
        },
      ])
    ).toEqual([
      {
        ...mockIssue,
        body: "Platforms: linux, mac",
      },
    ]);

    // Include new lines in issue body
    expect(
      getDisabledTestIssues(mockJob, [
        {
          ...mockIssue,
          body: "Platforms: linux, mac \n\rAnother line on the issue body",
        },
      ])
    ).toEqual([
      {
        ...mockIssue,
        body: "Platforms: linux, mac \n\rAnother line on the issue body",
      },
    ]);
  });
});
