import {
  hasSimilarFailures,
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

nock.disableNetConnect();

describe("Test various utils used by Dr.CI", () => {
  beforeEach(() => {});

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("test hasSimilarFailures", async () => {
    const headBranch = "mock-branch";
    const emptyBaseCommitDate = "";
    const lookbackPeriodInHours = 24;
    const mockHeadShaDate = dayjs("2023-08-01T00:00:00Z");
    const job: RecentWorkflowsData = {
      id: "12345",
      name: "pull / linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)",
      html_url: "A",
      head_sha: "A",
      head_sha_timestamp: mockHeadShaDate.toISOString(),
      failure_captures: ["ERROR"],
      conclusion: "failure",
      completed_at: mockHeadShaDate.toISOString(),
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
    mock.mockClear();

    const mockJobData: JobData = {
      name: "pull / linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 2, 5, linux.g5.4xlarge.nvidia.gpu, unstable)",
      workflowName: "pull",
      jobName:
        "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 2, 5, linux.g5.4xlarge.nvidia.gpu, unstable)",
      sha: "ABCD",
      id: "54321",
      branch: headBranch,
      workflowId: "12345",
      time: mockHeadShaDate.toISOString(),
      conclusion: "failure",
      htmlUrl: "Anything goes",
      failureLines: ["ERROR"],
      failureLineNumbers: [0],
      failureCaptures: ["ERROR"],
    };
    mock.mockImplementation(() => Promise.resolve({ jobs: [mockJobData] }));

    // Found a similar failure
    expect(
      await hasSimilarFailures(
        job,
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(true);
    expect(JSON.stringify(mock.mock.calls)).toEqual(
      JSON.stringify([
        [
          "TESTING",
          job.failure_captures.join(" "),
          "",
          "",
          searchUtils.WORKFLOW_JOB_INDEX,
          mockHeadShaDate.subtract(lookbackPeriodInHours, "hour"),
          mockHeadShaDate,
          searchUtils.MIN_SCORE,
          searchUtils.MAX_SIZE,
          searchUtils.OLDEST_FIRST,
        ],
      ])
    );

    // Found a match, but it belongs to the same branch, thus from the same PR,
    // so it will be ignored
    expect(
      await hasSimilarFailures(
        { ...job, head_branch: headBranch },
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    // Found a match but it has a different job name
    expect(
      await hasSimilarFailures(
        {
          ...job,
          name: "android-emulator-build-test / build-and-test (default, 1, 1, ubuntu-20.04-16x)",
        },
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    // Found a match, but it has the same job ID, thus the same job
    expect(
      await hasSimilarFailures(
        { ...job, id: mockJobData.id! },
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    // Found a match but it has a different failure
    expect(
      await hasSimilarFailures(
        { ...job, failure_captures: ["NOT THE SAME ERROR"] },
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    // Found a match but it has a different conclusion
    expect(
      await hasSimilarFailures(
        { ...job, conclusion: "neutral" },
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);

    mock.mockClear();
    // Check time ranges are correct
    await hasSimilarFailures(
      {
        ...job,
        head_sha_timestamp: mockHeadShaDate.subtract(1, "hour").toISOString(),
      },
      emptyBaseCommitDate,
      lookbackPeriodInHours,
      "TESTING" as unknown as Client
    );
    expect(JSON.stringify(mock.mock.calls)).toEqual(
      JSON.stringify([
        [
          "TESTING",
          job.failure_captures.join(" "),
          "",
          "",
          searchUtils.WORKFLOW_JOB_INDEX,
          mockHeadShaDate.subtract(1 + lookbackPeriodInHours, "hour"),
          mockHeadShaDate.subtract(1, "hour").toISOString(),
          searchUtils.MIN_SCORE,
          searchUtils.MAX_SIZE,
          searchUtils.OLDEST_FIRST,
        ],
      ])
    );

    mock.mockClear();
    // Check time ranges are correct when given a base commit that is relatively recent
    await hasSimilarFailures(
      {
        ...job,
        head_sha_timestamp: mockHeadShaDate.subtract(1, "hour").toISOString(),
      },
      mockHeadShaDate.subtract(20, "hour").toISOString(),
      lookbackPeriodInHours,
      "TESTING" as unknown as Client
    );
    expect(JSON.stringify(mock.mock.calls)).toEqual(
      JSON.stringify([
        [
          "TESTING",
          job.failure_captures.join(" "),
          "",
          "",
          searchUtils.WORKFLOW_JOB_INDEX,
          mockHeadShaDate.subtract(20 + lookbackPeriodInHours, "hour"),
          mockHeadShaDate.subtract(1, "hour").toISOString(),
          searchUtils.MIN_SCORE,
          searchUtils.MAX_SIZE,
          searchUtils.OLDEST_FIRST,
        ],
      ])
    );

    mock.mockClear();
    // Auto return false if time range is too large (base commit too old)
    expect(
      await hasSimilarFailures(
        job,
        mockHeadShaDate
          .subtract(
            MAX_SEARCH_HOURS_FOR_QUERYING_SIMILAR_FAILURES -
              lookbackPeriodInHours +
              1,
            "hour"
          )
          .toISOString(),
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);
    expect(mock).not.toHaveBeenCalled();

    mock.mockClear();
    // Auto return false if no head sha timestamp
    expect(
      await hasSimilarFailures(
        { ...job, head_sha_timestamp: "" },
        emptyBaseCommitDate,
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(false);
    expect(mock).not.toHaveBeenCalled();
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
