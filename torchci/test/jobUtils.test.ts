import {
  removeJobNameSuffix,
  isSameFailure,
  isSameAuthor,
  isSameContext,
  removeCancelledJobAfterRetry,
  isFailureFromPrevMergeCommit,
} from "../lib/jobUtils";
import { JobData, RecentWorkflowsData, BasicJobData } from "lib/types";
import nock from "nock";
import dayjs from "dayjs";
import * as getAuthors from "../lib/getAuthors";

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
    const job: RecentWorkflowsData = {
      head_sha: "123",
      // The rest doesn't matter
      id: "",
      completed_at: "",
      html_url: "",
      failure_captures: [],
    };
    const failure: RecentWorkflowsData = {
      head_sha: "456",
      // The rest doesn't matter
      id: "",
      completed_at: "",
      html_url: "",
      failure_captures: [],
    };

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
    const jobA: RecentWorkflowsData = {
      id: "A",
      name: "",
      html_url: "A",
      head_sha: "A",
      failure_captures: [],
      conclusion: "failure",
      completed_at: "A",
    };
    const jobB: RecentWorkflowsData = {
      id: "B",
      name: "",
      html_url: "B",
      head_sha: "B",
      failure_captures: [],
      conclusion: "failure",
      completed_at: "B",
    };

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
    const jobA: RecentWorkflowsData = {
      id: "A",
      name: "Testing",
      html_url: "A",
      head_sha: "A",
      failure_captures: ["Process completed with exit code 1"],
      failure_context: null,
      conclusion: "failure",
      completed_at: "A",
    };
    const jobB: RecentWorkflowsData = {
      id: "B",
      name: "Testing",
      html_url: "B",
      head_sha: "B",
      failure_captures: ["Process completed with exit code 1"],
      failure_context: null,
      conclusion: "failure",
      completed_at: "B",
    };

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
    const failure: RecentWorkflowsData = {
      id: "B",
      name: "Testing",
      html_url: "B",
      head_sha: "B",
      failure_captures: ["whatever"],
      conclusion: "failure",
      completed_at: "B",
    };

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
      ])
    );
  });
});
