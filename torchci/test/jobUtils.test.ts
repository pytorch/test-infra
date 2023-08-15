import {
  removeJobNameSuffix,
  hasSimilarFailures,
  querySimilarFailures,
  isSameFailure,
} from "../lib/jobUtils";
import * as searchUtils from "../lib/searchUtils";
import { JobData, RecentWorkflowsData } from "lib/types";
import nock from "nock";
import dayjs from "dayjs";
import { Client } from "@opensearch-project/opensearch";

nock.disableNetConnect();

describe("Test removing job name suffix", () => {
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

  test("test querySimilarFailures", async () => {
    const baseCommitDate = "";
    const lookbackPeriodInHours = 24;
    const mockEndDate = dayjs("2023-08-01T00:00:00Z").toISOString();
    const mockStartDate = dayjs(mockEndDate)
      .subtract(lookbackPeriodInHours, "hour")
      .toISOString();

    const mockJobData: JobData = {
      name: "pull / linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 2, 5, linux.g5.4xlarge.nvidia.gpu)",
      workflowName: "pull",
      jobName:
        "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 2, 5, linux.g5.4xlarge.nvidia.gpu)",
      sha: "ABCD",
      id: "54321",
      branch: "mock-branch",
      workflowId: "12345",
      time: mockEndDate,
      conclusion: "failure",
      htmlUrl: "Anything goes",
      failureLine: "ERROR",
      failureLineNumber: 0,
      failureCaptures: ["ERROR"],
    };
    const mock = jest.spyOn(searchUtils, "searchSimilarFailures");
    mock.mockImplementation(() => Promise.resolve({ jobs: [mockJobData] }));

    const job: RecentWorkflowsData = {
      id: "A",
      name: "",
      html_url: "A",
      head_sha: "A",
      failure_captures: ["ERROR"],
      conclusion: "failure",
      completed_at: mockEndDate,
    };
    // Missing job name
    expect(
      await querySimilarFailures(
        job,
        baseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toStrictEqual([]);

    job.name = "A";
    job.failure_captures = [];
    // Missing failures
    expect(
      await querySimilarFailures(
        job,
        baseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toStrictEqual([]);

    job.failure_captures = ["ERROR"];
    job.completed_at = null;
    // Missing date
    expect(
      await querySimilarFailures(
        job,
        baseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toStrictEqual([]);

    job.failure_captures = ["ERROR"];
    job.completed_at = mockEndDate;
    // Found a similar failure (mocked)
    expect(
      await querySimilarFailures(
        job,
        baseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toStrictEqual([mockJobData]);
    expect(JSON.stringify(mock.mock.calls)).toEqual(
      JSON.stringify([
        [
          "TESTING",
          job.failure_captures.join(" "),
          searchUtils.WORKFLOW_JOB_INDEX,
          mockStartDate,
          mockEndDate,
          searchUtils.MIN_SCORE,
        ],
      ])
    );
  });

  test("test hasSimilarFailures", async () => {
    const baseCommitDate = "";
    const lookbackPeriodInHours = 24;
    const job: RecentWorkflowsData = {
      id: "A",
      name: "A",
      html_url: "A",
      head_sha: "A",
      failure_captures: ["ERROR"],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
    };

    const mock = jest.spyOn(searchUtils, "searchSimilarFailures");
    mock.mockImplementation(() => Promise.resolve({ jobs: [] }));
    // Found no similar job
    expect(
      await hasSimilarFailures(
        job,
        baseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    const id = "54321";
    const mockJobData: JobData = {
      name: "pull / linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 2, 5, linux.g5.4xlarge.nvidia.gpu, unstable)",
      workflowName: "pull",
      jobName:
        "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 2, 5, linux.g5.4xlarge.nvidia.gpu, unstable)",
      sha: "ABCD",
      id: id,
      branch: "mock-branch",
      workflowId: "12345",
      time: "2023-08-01T00:00:00Z",
      conclusion: "failure",
      htmlUrl: "Anything goes",
      failureLine: "ERROR",
      failureLineNumber: 0,
      failureCaptures: ["ERROR"],
    };
    mock.mockImplementation(() => Promise.resolve({ jobs: [mockJobData] }));

    job.id = id;
    // Found a match, but it has the same job ID, thus the same job
    expect(
      await hasSimilarFailures(
        job,
        baseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    job.id = "0";
    job.name =
      "android-emulator-build-test / build-and-test (default, 1, 1, ubuntu-20.04-16x)";
    job.failure_captures = ["ERROR"];
    // Found a match but it has a different job name
    expect(
      await hasSimilarFailures(
        job,
        baseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    job.id = "0";
    job.name =
      "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)";
    job.failure_captures = ["NOT THE SAME ERROR"];
    // Found a match but it has a different failure
    expect(
      await hasSimilarFailures(
        job,
        baseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    job.id = "0";
    job.name =
      "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)";
    job.failure_captures = ["ERROR"];
    job.conclusion = "neutral";
    // Found a match but it has a different conclusion
    expect(
      await hasSimilarFailures(
        job,
        baseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    job.id = "0";
    job.name =
      "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)";
    job.failure_captures = ["ERROR"];
    job.conclusion = "failure";
    // Found a similar failure
    expect(
      await hasSimilarFailures(
        job,
        baseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(true);
  });
});
