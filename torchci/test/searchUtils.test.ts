import * as searchUtils from "../lib/searchUtils";
import { JobData } from "lib/types";
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

  test("test searchUtils.querySimilarFailures", async () => {
    const lookbackPeriodInHours = 24;
    const mockEndDate = dayjs("2023-08-01T00:00:00Z");
    const mockStartDate = dayjs(mockEndDate).subtract(
      lookbackPeriodInHours,
      "hour"
    );

    const mockJobData: JobData = {
      name: "pull / linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 2, 5, linux.g5.4xlarge.nvidia.gpu)",
      workflowName: "pull",
      jobName:
        "linux-bionic-cuda12.1-py3.10-gcc9-sm86 / test (default, 2, 5, linux.g5.4xlarge.nvidia.gpu)",
      sha: "ABCD",
      id: "54321",
      branch: "mock-branch",
      workflowId: "12345",
      time: mockEndDate.toISOString(),
      conclusion: "failure",
      htmlUrl: "Anything goes",
      failureLines: ["ERROR"],
      failureLineNumbers: [0],
      failureCaptures: ["ERROR"],
    };
    const mock = jest.spyOn(searchUtils, "searchSimilarFailures");
    mock.mockImplementation(() => Promise.resolve({ jobs: [mockJobData] }));

    const query = {
      name: "A",
      jobName: "",
      failure_captures: ["ERROR"],
      startDate: mockStartDate,
      endDate: mockEndDate,
      maxSize: searchUtils.MAX_SIZE,
      sortByTimeStamp: searchUtils.OLDEST_FIRST,
      client: "TESTING" as unknown as Client,
    };

    // Found a similar failure (mocked)
    expect(
      await searchUtils.querySimilarFailures({
        ...query,
      })
    ).toStrictEqual([mockJobData]);
    expect(JSON.stringify(mock.mock.calls)).toEqual(
      JSON.stringify([
        [
          "TESTING",
          query.failure_captures.join(" "),
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

    // Missing job name
    expect(
      await searchUtils.querySimilarFailures({
        ...query,
        name: "",
      })
    ).toStrictEqual([]);

    // Missing failures
    expect(
      await searchUtils.querySimilarFailures({
        ...query,
        failure_captures: [],
      })
    ).toStrictEqual([]);

    // Check if the workflow name is set
    expect(
      await searchUtils.querySimilarFailures({
        ...query,
        jobName: "job / test",
        name: `pull / job / test`,
      })
    ).toStrictEqual([mockJobData]);
    expect(JSON.stringify(mock.mock.calls)).toEqual(
      JSON.stringify([
        [
          "TESTING",
          query.failure_captures.join(" "),
          "pull",
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
  });
});
