import { Client } from "@opensearch-project/opensearch";
import dayjs from "dayjs";
import { TIME_0 } from "lib/bot/utils";
import { JobData, RecentWorkflowsData } from "lib/types";
import nock from "nock";
import * as commitUtils from "../lib/commitUtils";
import * as drciUtils from "../lib/drciUtils";
import {
  getSuppressedLabels,
  hasSimilarFailures,
  hasSimilarFailuresInSamePR,
  isExcludedFromFlakiness,
  isExcludedFromSimilarityPostProcessing,
  isInfraFlakyJob,
  isLogClassifierFailed,
  MAX_SEARCH_HOURS_FOR_QUERYING_SIMILAR_FAILURES,
} from "../lib/drciUtils";
import * as jobUtils from "../lib/jobUtils";
import * as searchUtils from "../lib/searchUtils";
import { getDummyJob } from "./drci.test";

nock.disableNetConnect();

describe("Test various utils used by Dr.CI", () => {
  beforeEach(() => {});

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  test("test hasSimilarFailures", async () => {
    const headBranch = "main";
    const emptyBaseCommitDate = TIME_0;
    const lookbackPeriodInHours = 24;
    const mockHeadShaDate = dayjs("2023-08-01T00:00:00Z").utc();
    const job: RecentWorkflowsData = getDummyJob({
      id: 12345,
      name: "pull / linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 1, 5, linux.g5.4xlarge.nvidia.gpu)",
      html_url: "A",
      head_sha: "A",
      head_sha_timestamp: mockHeadShaDate.format("YYYY-MM-DD HH:mm:ss"),
      failure_captures: ["ERROR"],
      conclusion: "failure",
      completed_at: mockHeadShaDate.format("YYYY-MM-DD HH:mm:ss"),
      head_branch: "whatever",
    });
    const jobWithGenericError: RecentWorkflowsData = {
      ...job,
      failure_captures: ["##[error]The operation was canceled."],
    };

    const mock = jest.spyOn(searchUtils, "searchSimilarFailures");
    mock.mockImplementation(() => Promise.resolve({ jobs: [] }));
    const mockJobUtils = jest.spyOn(drciUtils, "isSameAuthor");
    mockJobUtils.mockImplementation(() => Promise.resolve(false));
    const mockCommitUtils = jest.spyOn(
      commitUtils,
      "isEligibleCommitForSimilarFailureCheck"
    );
    mockCommitUtils.mockImplementation(() => Promise.resolve(true));

    // Found no similar job
    expect(
      await hasSimilarFailures(
        job,
        emptyBaseCommitDate,
        [],
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(undefined);
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
      time: mockHeadShaDate.format("YYYY-MM-DD HH:mm:ss"),
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
        [],
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual({
      authorEmail: undefined,
      completed_at: mockJobData.time,
      conclusion: mockJobData.conclusion,
      failure_captures: mockJobData.failureCaptures,
      failure_context: undefined,
      failure_lines: mockJobData.failureLines,
      head_branch: mockJobData.branch,
      head_sha: mockJobData.sha,
      head_sha_timestamp: TIME_0,
      html_url: mockJobData.htmlUrl,
      id: mockJobData.id,
      jobName: mockJobData.jobName,
      name: mockJobData.name,
      pr_number: 0,
      workflowId: mockJobData.workflowId,
      workflowUniqueId: 0,
    });
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

    // Found a match, but it belongs to the merge commits of the same PR, so it
    // will be ignored to avoid misclassification after the PR is reverted
    expect(
      await hasSimilarFailures(
        { ...job, head_branch: "main" },
        emptyBaseCommitDate,
        ["ABCD"],
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(undefined);

    // Found a match, but it belongs to the same branch, thus from the same PR,
    // so it will be ignored
    expect(
      await hasSimilarFailures(
        { ...job, head_branch: headBranch },
        emptyBaseCommitDate,
        [],
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(undefined);

    // Found a match but it has a different job name
    expect(
      await hasSimilarFailures(
        {
          ...job,
          name: "android-emulator-build-test / build-and-test (default, 1, 1, ubuntu-20.04-16x)",
        },
        emptyBaseCommitDate,
        [],
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(undefined);

    // Found a match, but it has the same job ID, thus the same job
    expect(
      await hasSimilarFailures(
        { ...job, id: mockJobData.id! as any as number },
        emptyBaseCommitDate,
        [],
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(undefined);

    // Found a match but it has a different failure
    expect(
      await hasSimilarFailures(
        { ...job, failure_captures: ["NOT THE SAME ERROR"] },
        emptyBaseCommitDate,
        [],
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(undefined);

    // Found a match but it has a different conclusion
    expect(
      await hasSimilarFailures(
        { ...job, conclusion: "neutral" },
        emptyBaseCommitDate,
        [],
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(undefined);

    mock.mockClear();
    // Check time ranges are correct
    await hasSimilarFailures(
      {
        ...job,
        head_sha_timestamp: mockHeadShaDate
          .subtract(1, "hour")
          .format("YYYY-MM-DD HH:mm:ss"),
      },
      emptyBaseCommitDate,
      [],
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
          mockHeadShaDate.subtract(1, "hour"),
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
        head_sha_timestamp: mockHeadShaDate
          .subtract(1, "hour")
          .format("YYYY-MM-DD HH:mm:ss"),
      },
      mockHeadShaDate.subtract(20, "hour").format("YYYY-MM-DD HH:mm:ss"),
      [],
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
          mockHeadShaDate.subtract(1, "hour"),
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
          .format("YYYY-MM-DD HH:mm:ss"),
        [],
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(undefined);
    expect(mock).not.toHaveBeenCalled();

    mock.mockClear();
    // Auto return false if no head sha timestamp
    expect(
      await hasSimilarFailures(
        { ...job, head_sha_timestamp: TIME_0 },
        emptyBaseCommitDate,
        [],
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(undefined);
    expect(mock).not.toHaveBeenCalled();

    mockCommitUtils.mockImplementation(() => Promise.resolve(false));
    // Found a match but it belongs to a commit that is not eligible for similarity check
    expect(
      await hasSimilarFailures(
        job,
        emptyBaseCommitDate,
        [],
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(undefined);

    // Found a match but it has a generic error
    expect(
      await hasSimilarFailures(
        jobWithGenericError,
        emptyBaseCommitDate,
        [],
        lookbackPeriodInHours,
        "TESTING" as unknown as Client
      )
    ).toEqual(undefined);
  });

  test("test isInfraFlakyJob", () => {
    // Not a workflow job
    const notInfraFlakyFailure: RecentWorkflowsData = getDummyJob({
      id: 1,
      name: "A",
      html_url: "A",
      head_sha: "A",
      failure_lines: ["ERROR"],
      failure_captures: ["ERROR"],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "dummy",
    });
    expect(isInfraFlakyJob(notInfraFlakyFailure)).toEqual(false);

    // Set the workflow ID to mark this as a workflow job
    notInfraFlakyFailure.workflowId = 1;
    expect(isInfraFlakyJob(notInfraFlakyFailure)).toEqual(false);

    const notInfraFlakyFailureAgain: RecentWorkflowsData = getDummyJob({
      id: 1,
      workflowId: 1,
      name: "A",
      html_url: "A",
      head_sha: "A",
      failure_lines: [""],
      failure_captures: [],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "dummy",
    });
    expect(isInfraFlakyJob(notInfraFlakyFailureAgain)).toEqual(false);

    const isInfraFlakyFailure: RecentWorkflowsData = getDummyJob({
      id: 1,
      workflowId: 1,
      name: "A",
      html_url: "A",
      head_sha: "A",
      failure_lines: [""],
      failure_captures: [],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "",
    });
    expect(isInfraFlakyJob(isInfraFlakyFailure)).toEqual(true);
  });

  test("test isLogClassifierFailed", async () => {
    const mockJobUtils = jest.spyOn(jobUtils, "hasS3Log");
    mockJobUtils.mockImplementation(() => Promise.resolve(true));

    // Not a workflow job
    const mockFailure: RecentWorkflowsData = getDummyJob({
      id: 1,
      name: "A",
      html_url: "A",
      head_sha: "A",
      failure_lines: ["ERROR"],
      failure_captures: ["ERROR"],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "dummy",
    });
    expect(await isLogClassifierFailed(mockFailure)).toEqual(false);

    // Has log and failure lines and is a workflow job
    mockFailure.workflowId = 1;
    expect(await isLogClassifierFailed(mockFailure)).toEqual(false);

    // Has log but not failure lines (log classifier not triggered)
    const logClassifierNotTriggered: RecentWorkflowsData = getDummyJob({
      id: 1,
      workflowId: 1,
      name: "A",
      html_url: "A",
      head_sha: "A",
      failure_lines: [],
      failure_captures: [],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "dummy",
    });
    expect(await isLogClassifierFailed(logClassifierNotTriggered)).toEqual(
      true
    );

    // No S3 log
    mockJobUtils.mockImplementation(() => Promise.resolve(false));
    expect(await isLogClassifierFailed(mockFailure)).toEqual(true);
  });

  test("test isExcludedFromFlakiness", () => {
    const excludedJob: RecentWorkflowsData = getDummyJob({
      id: 1,
      name: "LinT / quick-checks / linux-job",
      html_url: "A",
      head_sha: "A",
      failure_lines: ["ERROR"],
      failure_captures: ["ERROR"],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "dummy",
    });
    expect(isExcludedFromFlakiness(excludedJob)).toEqual(true);

    const anotherExcludedJob: RecentWorkflowsData = getDummyJob({
      id: 1,
      name: "pull / linux-docs / build-docs-python-false",
      html_url: "A",
      head_sha: "A",
      failure_lines: [""],
      failure_captures: [],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "dummy",
    });
    expect(isExcludedFromFlakiness(anotherExcludedJob)).toEqual(true);

    const notExcludedJob: RecentWorkflowsData = getDummyJob({
      id: 1,
      name: "A",
      html_url: "A",
      head_sha: "A",
      failure_lines: [""],
      failure_captures: [],
      conclusion: "failure",
      completed_at: "2023-08-01T00:00:00Z",
      head_branch: "whatever",
      runnerName: "dummy",
    });
    expect(isExcludedFromFlakiness(notExcludedJob)).toEqual(false);
  });

  test("test getSuppressedLabels", () => {
    const job: RecentWorkflowsData = getDummyJob({
      jobName: "not suppressed job",

      // Doesn't matter, just mocking
      id: 1,
      completed_at: "2023-08-01T00:00:00Z",
      html_url: "A",
      head_sha: "A",
      failure_captures: ["ERROR"],
    });

    // Not supported
    expect(getSuppressedLabels(job, ["anything goes"])).toEqual([]);

    job.jobName = "bc_linter";
    // Not suppressed
    expect(getSuppressedLabels(job, [])).toEqual([]);
    expect(getSuppressedLabels(job, ["anything goes"])).toEqual([]);
    // Suppress, the job will be hidden on CI and doesn't block merge
    expect(getSuppressedLabels(job, ["suppress-bc-linter"])).toEqual([
      "suppress-bc-linter",
    ]);
    expect(
      getSuppressedLabels(job, ["suppress-api-compatibility-check"])
    ).toEqual(["suppress-api-compatibility-check"]);
    expect(
      getSuppressedLabels(job, [
        "suppress-bc-linter",
        "suppress-api-compatibility-check",
      ])
    ).toEqual(["suppress-bc-linter", "suppress-api-compatibility-check"]);
  });

  test("test isExcludedFromSimilarityPostProcessing", () => {
    const job: RecentWorkflowsData = getDummyJob({
      jobName: "A job name",

      // Doesn't matter, just mocking
      id: 1,
      completed_at: "2023-08-01T00:00:00Z",
      html_url: "A",
      head_sha: "A",
      failure_captures: [],
    });
    expect(isExcludedFromSimilarityPostProcessing(job)).toEqual(false);

    job.failure_captures.push("ERROR");
    expect(isExcludedFromSimilarityPostProcessing(job)).toEqual(false);

    job.failure_captures.push("Process completed with exit code 1");
    expect(isExcludedFromSimilarityPostProcessing(job)).toEqual(true);
  });

  test("test hasSimilarFailuresInSamePR", () => {
    const job: RecentWorkflowsData = getDummyJob({
      name: "a job name",

      // Doesn't matter, just mocking
      id: 1,
      completed_at: "2023-08-01T00:00:00Z",
      html_url: "A",
      head_sha: "A",
      failure_captures: ["A mock error"],
    });
    const failures: RecentWorkflowsData[] = [
      getDummyJob({
        name: "a job name",

        // Doesn't matter, just mocking
        id: 1,
        completed_at: "2023-08-01T00:00:00Z",
        html_url: "A",
        head_sha: "A",
        failure_captures: ["A different mock error"],
      }),
      getDummyJob({
        name: "a different job name",

        // Doesn't matter, just mocking
        id: 1,
        completed_at: "2023-08-01T00:00:00Z",
        html_url: "A",
        head_sha: "A",
        failure_captures: ["A different mock error"],
      }),
    ];
    expect(hasSimilarFailuresInSamePR(job, failures)).toEqual(undefined);

    failures.push(
      getDummyJob({
        name: "another different job name",

        // Doesn't matter, just mocking
        id: 1,
        completed_at: "2023-08-01T00:00:00Z",
        html_url: "A",
        head_sha: "A",
        failure_captures: ["A mock error"],
      })
    );
    expect(hasSimilarFailuresInSamePR(job, failures)?.name).toEqual(
      "another different job name"
    );
  });
});
