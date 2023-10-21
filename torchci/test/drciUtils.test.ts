import {
  hasSimilarFailures,
  querySimilarFailures,
  isInfraFlakyJob,
  isExcludedFromFlakiness,
} from "../lib/drciUtils";
import * as searchUtils from "../lib/searchUtils";
import { JobData, RecentWorkflowsData } from "lib/types";
import nock from "nock";
import dayjs from "dayjs";
import { Client } from "@opensearch-project/opensearch";

nock.disableNetConnect();

describe("Test various utils used by Dr.CI", () => {
  beforeEach(() => {});

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("test querySimilarFailures", async () => {
    const emptyBaseCommitDate = "";
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
      failureLines: ["ERROR"],
      failureLineNumbers: [0],
      failureCaptures: ["ERROR"],
    };
    const mock = jest.spyOn(searchUtils, "searchSimilarFailures");
    mock.mockImplementation(() => Promise.resolve({ jobs: [mockJobData] }));

    const job: RecentWorkflowsData = {
      id: "A",
      name: "",
      jobName: "",
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
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        searchUtils.MAX_SIZE,
        "TESTING" as unknown as Client
      )
    ).toStrictEqual([]);

    job.name = "A";
    job.failure_captures = [];
    // Missing failures
    expect(
      await querySimilarFailures(
        job,
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        searchUtils.MAX_SIZE,
        "TESTING" as unknown as Client
      )
    ).toStrictEqual([]);

    job.failure_captures = ["ERROR"];
    job.completed_at = null;
    // Missing date
    expect(
      await querySimilarFailures(
        job,
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        searchUtils.MAX_SIZE,
        "TESTING" as unknown as Client
      )
    ).toStrictEqual([]);

    job.failure_captures = ["ERROR"];
    job.completed_at = mockEndDate;
    // Found a similar failure (mocked)
    expect(
      await querySimilarFailures(
        job,
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        searchUtils.MAX_SIZE,
        "TESTING" as unknown as Client
      )
    ).toStrictEqual([mockJobData]);
    expect(JSON.stringify(mock.mock.calls)).toEqual(
      JSON.stringify([
        [
          "TESTING",
          job.failure_captures.join(" "),
          "",
          searchUtils.WORKFLOW_JOB_INDEX,
          mockStartDate,
          mockEndDate,
          searchUtils.MIN_SCORE,
          searchUtils.MAX_SIZE,
        ],
      ])
    );

    mock.mockClear();
    const baseCommitDate = "2023-07-01T00:00:00Z";

    // Use base commit date
    expect(
      await querySimilarFailures(
        job,
        baseCommitDate,
        lookbackPeriodInHours,
        searchUtils.MAX_SIZE,
        "TESTING" as unknown as Client
      )
    ).toStrictEqual([mockJobData]);
    expect(JSON.stringify(mock.mock.calls)).toEqual(
      JSON.stringify([
        [
          "TESTING",
          job.failure_captures.join(" "),
          "",
          searchUtils.WORKFLOW_JOB_INDEX,
          dayjs(baseCommitDate)
            .subtract(lookbackPeriodInHours, "hour")
            .toISOString(),
          mockEndDate,
          searchUtils.MIN_SCORE,
          searchUtils.MAX_SIZE,
        ],
      ])
    );

    mock.mockClear();

    const workflowName = "pull";
    job.jobName = "job / test";
    job.name = `${workflowName} / ${job.jobName}`;
    // Check if the workflow name is set
    expect(
      await querySimilarFailures(
        job,
        baseCommitDate,
        lookbackPeriodInHours,
        searchUtils.MAX_SIZE,
        "TESTING" as unknown as Client
      )
    ).toStrictEqual([mockJobData]);
    expect(JSON.stringify(mock.mock.calls)).toEqual(
      JSON.stringify([
        [
          "TESTING",
          job.failure_captures.join(" "),
          workflowName,
          searchUtils.WORKFLOW_JOB_INDEX,
          dayjs(baseCommitDate)
            .subtract(lookbackPeriodInHours, "hour")
            .toISOString(),
          mockEndDate,
          searchUtils.MIN_SCORE,
          searchUtils.MAX_SIZE,
        ],
      ])
    );
  });

  test("test hasSimilarFailures", async () => {
    const headBranch = "mock-branch";
    const emptyBaseCommitDate = "";
    const lookbackPeriodInHours = 24;
    const job: RecentWorkflowsData = {
      id: "A",
      name: "A",
      html_url: "A",
      head_sha: "A",
      failure_captures: ["ERROR"],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
    };

    const mock = jest.spyOn(searchUtils, "searchSimilarFailures");
    mock.mockImplementation(() => Promise.resolve({ jobs: [] }));
    // Found no similar job
    expect(
      await hasSimilarFailures(
        job,
        emptyBaseCommitDate,
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
      branch: headBranch,
      workflowId: "12345",
      time: "2023-08-01T00:00:00Z",
      conclusion: "failure",
      htmlUrl: "Anything goes",
      failureLines: ["ERROR"],
      failureLineNumbers: [0],
      failureCaptures: ["ERROR"],
    };
    mock.mockImplementation(() => Promise.resolve({ jobs: [mockJobData] }));

    job.id = id;
    // Found a match, but it has the same job ID, thus the same job
    expect(
      await hasSimilarFailures(
        job,
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    job.id = "0";
    job.head_branch = headBranch;
    // Found a match, but it belongs to the same branch, thus from the same PR,
    // so it will be ignored
    expect(
      await hasSimilarFailures(
        job,
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    job.id = "0";
    job.name =
      "android-emulator-build-test / build-and-test (default, 1, 1, ubuntu-20.04-16x)";
    job.failure_captures = ["ERROR"];
    job.head_branch = "whatever";
    // Found a match but it has a different job name
    expect(
      await hasSimilarFailures(
        job,
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    job.id = "0";
    job.name =
      "pull / linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)";
    job.failure_captures = ["NOT THE SAME ERROR"];
    // Found a match but it has a different failure
    expect(
      await hasSimilarFailures(
        job,
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    job.id = "0";
    job.name =
      "pull / linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)";
    job.failure_captures = ["ERROR"];
    job.conclusion = "neutral";
    // Found a match but it has a different conclusion
    expect(
      await hasSimilarFailures(
        job,
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    job.id = "0";
    job.name =
      "pull / linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)";
    job.failure_captures = ["ERROR"];
    job.conclusion = "failure";
    // Found a similar failure
    expect(
      await hasSimilarFailures(
        job,
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(true);
  });

  test("test isInfraFlakyJob", () => {
    const notInfraFlakyFailure: RecentWorkflowsData = {
      id: "A",
      name: "A",
      html_url: "A",
      head_sha: "A",
      failure_lines: ["ERROR"],
      failure_captures: ["ERROR"],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "dummy",
    };
    expect(isInfraFlakyJob(notInfraFlakyFailure)).toEqual(false);

    const notInfraFlakyFailureAgain: RecentWorkflowsData = {
      id: "A",
      name: "A",
      html_url: "A",
      head_sha: "A",
      failure_lines: [""],
      failure_captures: [],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "dummy",
    };
    expect(isInfraFlakyJob(notInfraFlakyFailureAgain)).toEqual(false);

    const isInfraFlakyFailure: RecentWorkflowsData = {
      id: "A",
      name: "A",
      html_url: "A",
      head_sha: "A",
      failure_lines: [""],
      failure_captures: [],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "",
    };
    expect(isInfraFlakyJob(isInfraFlakyFailure)).toEqual(true);
  });

  test("test isExcludedFromFlakiness", () => {
    const excludedJob: RecentWorkflowsData = {
      id: "A",
      name: "LinT / quick-checks / linux-job",
      html_url: "A",
      head_sha: "A",
      failure_lines: ["ERROR"],
      failure_captures: ["ERROR"],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "dummy",
    };
    expect(isExcludedFromFlakiness(excludedJob)).toEqual(true);

    const anotherExcludedJob: RecentWorkflowsData = {
      id: "A",
      name: "pull / linux-docs / build-docs-python-false",
      html_url: "A",
      head_sha: "A",
      failure_lines: [""],
      failure_captures: [],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "dummy",
    };
    expect(isExcludedFromFlakiness(anotherExcludedJob)).toEqual(true);

    const notExcludedJob: RecentWorkflowsData = {
      id: "A",
      name: "A",
      html_url: "A",
      head_sha: "A",
      failure_lines: [""],
      failure_captures: [],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "dummy",
    };
    expect(isExcludedFromFlakiness(notExcludedJob)).toEqual(false);
  });
});
