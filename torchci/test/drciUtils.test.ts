import {
  hasSimilarFailures,
  querySimilarFailures,
  isInfraFlakyJob,
  isExcludedFromFlakiness,
  isLogClassifierFailed,
  isSuppressedByLabels,
  MAX_SEARCH_HOURS_FOR_QUERYING_SIMILAR_FAILURES,
} from "../lib/drciUtils";
import * as searchUtils from "../lib/searchUtils";
import * as jobUtils from "../lib/jobUtils";
import { JobData, RecentWorkflowsData } from "lib/types";
import nock from "nock";
import dayjs from "dayjs";
import { Client } from "@opensearch-project/opensearch";
import * as utils from "./utils";

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
        searchUtils.OLDEST_FIRST,
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
        searchUtils.OLDEST_FIRST,
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
        searchUtils.OLDEST_FIRST,
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
        searchUtils.OLDEST_FIRST,
        "TESTING" as unknown as Client
      )
    ).toStrictEqual([mockJobData]);
    expect(JSON.stringify(mock.mock.calls)).toEqual(
      JSON.stringify([
        [
          "TESTING",
          job.failure_captures.join(" "),
          "",
          "",
          searchUtils.WORKFLOW_JOB_INDEX,
          mockStartDate,
          mockEndDate,
          searchUtils.MIN_SCORE,
          searchUtils.MAX_SIZE,
          searchUtils.OLDEST_FIRST,
        ],
      ])
    );

    mock.mockClear();
    const baseCommitDate = "2023-07-31T00:00:00Z";

    // Use base commit date
    expect(
      await querySimilarFailures(
        job,
        baseCommitDate,
        lookbackPeriodInHours,
        searchUtils.MAX_SIZE,
        searchUtils.OLDEST_FIRST,
        "TESTING" as unknown as Client
      )
    ).toStrictEqual([mockJobData]);
    expect(JSON.stringify(mock.mock.calls)).toEqual(
      JSON.stringify([
        [
          "TESTING",
          job.failure_captures.join(" "),
          "",
          "",
          searchUtils.WORKFLOW_JOB_INDEX,
          dayjs(baseCommitDate)
            .subtract(lookbackPeriodInHours, "hour")
            .toISOString(),
          mockEndDate,
          searchUtils.MIN_SCORE,
          searchUtils.MAX_SIZE,
          searchUtils.OLDEST_FIRST,
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
        searchUtils.OLDEST_FIRST,
        "TESTING" as unknown as Client
      )
    ).toStrictEqual([mockJobData]);
    expect(JSON.stringify(mock.mock.calls)).toEqual(
      JSON.stringify([
        [
          "TESTING",
          job.failure_captures.join(" "),
          workflowName,
          "",
          searchUtils.WORKFLOW_JOB_INDEX,
          dayjs(baseCommitDate)
            .subtract(lookbackPeriodInHours, "hour")
            .toISOString(),
          mockEndDate,
          searchUtils.MIN_SCORE,
          searchUtils.MAX_SIZE,
          searchUtils.OLDEST_FIRST,
        ],
      ])
    );

    mock.mockClear();
    // The base commit date is too old, and flaky detection doesn't apply to avoid FPs
    const oldBaseCommitDate = dayjs(mockEndDate)
      .subtract(MAX_SEARCH_HOURS_FOR_QUERYING_SIMILAR_FAILURES - 23, "hour")
      .toISOString();

    expect(
      await querySimilarFailures(
        job,
        oldBaseCommitDate,
        lookbackPeriodInHours,
        searchUtils.MAX_SIZE,
        searchUtils.OLDEST_FIRST,
        "TESTING" as unknown as Client
      )
    ).toStrictEqual([]);
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
    const mockJobUtils = jest.spyOn(jobUtils, "isSameAuthor");
    mockJobUtils.mockImplementation(() => Promise.resolve(false));

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
    // Not a workflow job
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

    // Set the workflow ID to mark this as a workflow job
    notInfraFlakyFailure.workflowId = "A";
    expect(isInfraFlakyJob(notInfraFlakyFailure)).toEqual(false);

    const notInfraFlakyFailureAgain: RecentWorkflowsData = {
      id: "A",
      workflowId: "A",
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
      workflowId: "A",
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

  test("test isLogClassifierFailed", async () => {
    const mockJobUtils = jest.spyOn(jobUtils, "hasS3Log");
    mockJobUtils.mockImplementation(() => Promise.resolve(true));

    // Not a workflow job
    const mockFailure: RecentWorkflowsData = {
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
    expect(await isLogClassifierFailed(mockFailure)).toEqual(false);

    // Has log and failure lines and is a workflow job
    mockFailure.workflowId = "A";
    expect(await isLogClassifierFailed(mockFailure)).toEqual(false);

    // Has log but not failure lines (log classifier not triggered)
    const logClassifierNotTriggered: RecentWorkflowsData = {
      id: "A",
      workflowId: "A",
      name: "A",
      html_url: "A",
      head_sha: "A",
      failure_lines: [],
      failure_captures: [],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "dummy",
    };
    expect(await isLogClassifierFailed(logClassifierNotTriggered)).toEqual(
      true
    );

    // No S3 log
    mockJobUtils.mockImplementation(() => Promise.resolve(false));
    expect(await isLogClassifierFailed(mockFailure)).toEqual(true);
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

  test("test isSuppressedByLabels", () => {
    const job: RecentWorkflowsData = {
      jobName: "not suppressed job",

      // Doesn't matter, just mocking
      id: "A",
      completed_at: "2023-08-01T00:00:00Z",
      html_url: "A",
      head_sha: "A",
      failure_captures: ["ERROR"],
    };

    // Not supported
    expect(isSuppressedByLabels(job, ["anything goes"])).toEqual(false);

    job.jobName = "bc_linter";
    // Not suppressed
    expect(isSuppressedByLabels(job, [])).toEqual(false);
    expect(isSuppressedByLabels(job, ["anything goes"])).toEqual(false);
    // Suppress, the job will be hidden on CI and doesn't block merge
    expect(isSuppressedByLabels(job, ["suppress-bc-linter"])).toEqual(true);
    expect(
      isSuppressedByLabels(job, ["suppress-api-compatibility-check"])
    ).toEqual(true);
    expect(
      isSuppressedByLabels(job, [
        "suppress-bc-linter",
        "suppress-api-compatibility-check",
      ])
    ).toEqual(true);
  });
});
