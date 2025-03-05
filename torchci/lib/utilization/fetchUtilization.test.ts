import { createClient } from "@clickhouse/client";
import fetchUtilization, { flattenTS } from "./fetchUtilization";
import { TimeSeriesDbData } from "./types";

// run test using yarn test test-infra/torchci/lib/utilization_api/fetchUtilization.test.ts
const TEST_GPU_USAGE_11 = {
  uuid: "uuid-1",
  util_percent: {
    avg: 0.0,
    max: 0.0,
  },
  mem_util_percent: {
    avg: 10,
    max: 10,
  },
};
const TEST_GPU_USAGE_22 = {
  uuid: "uuid-2",
  util_percent: {
    avg: 20,
    max: 20,
  },
  mem_util_percent: {
    avg: 20,
    max: 20,
  },
};

const TEST_GPU_USAGE_13 = {
  uuid: "uuid-1",
  util_percent: {
    avg: 30,
    max: 30,
  },
  mem_util_percent: {
    avg: 30,
    max: 30,
  },
};

const TEST_GPU_USAGE_24 = {
  uuid: "uuid-2",
  util_percent: {
    avg: 40,
    max: 40,
  },
  mem_util_percent: {
    avg: 40,
    max: 40,
  },
};

const TEST_DATA_1 = {
  ts: "2023-10-10 13:00:00",
  data: JSON.stringify({
    cpu: {
      avg: 10,
      max: 10,
    },
    memory: {
      avg: 10,
      max: 10,
    },
    gpu_usage: [TEST_GPU_USAGE_11, TEST_GPU_USAGE_22],
  }),
  tags: [],
};

const TEST_DATA_2 = {
  ts: "2023-10-10 16:00:00",
  data: JSON.stringify({
    cpu: {
      avg: 20,
      max: 20,
    },
    memory: {
      avg: 20,
      max: 20,
    },
    gpu_usage: [TEST_GPU_USAGE_13, TEST_GPU_USAGE_24],
  }),
  tags: [],
};

const TEST_DATA_3 = {
  ts: "2023-10-10 18:00:00",
  data: JSON.stringify({
    cpu: {
      avg: 2.43,
      max: 6.4,
    },
    memory: {
      avg: 5.25,
      max: 5.8,
    },
    gpu_usage: null,
  }),
  tags: [],
};

const BASE_TEST_LIST: TimeSeriesDbData[] = [TEST_DATA_1, TEST_DATA_2];

jest.mock("@clickhouse/client", () => ({
  createClient: jest.fn(),
}));

describe("Test flattenTS to flatten timestamp", () => {
  it("should generate map of timestamp", () => {
    const res = flattenTS(BASE_TEST_LIST);
    const resKeys = Array.from(res.keys());

    // assert map keys
    expect(resKeys.length).toEqual(12);
    expect(resKeys.filter((x) => x.includes("cpu")).length).toEqual(2);
    expect(resKeys.filter((x) => x.includes("gpu")).length).toEqual(8);
    expect(resKeys.filter((x) => x.includes("memory")).length).toEqual(2);
    expect(resKeys.filter((x) => x.includes("max")).length).toEqual(6);
    expect(resKeys.filter((x) => x.includes("avg")).length).toEqual(6);

    // assert map values
    resKeys.forEach((key, _) => {
      expect(res.get(key)?.length).toEqual(2);
    });

    const cpu_avg_ts = res.get("cpu|avg");
    expect(cpu_avg_ts).toEqual([
      { ts: "2023-10-10 13:00:00", value: 10 },
      { ts: "2023-10-10 16:00:00", value: 20 },
    ]);

    const gpu_1_max = res.get("gpu_usage|0|uuid:uuid-1|mem_util_percent|max");
    expect(gpu_1_max).toEqual([
      { ts: "2023-10-10 13:00:00", value: 10 },
      { ts: "2023-10-10 16:00:00", value: 30 },
    ]);
  });

  it("should generate map of timestamp when gpu_usage is null", () => {
    const res = flattenTS([TEST_DATA_3]);
    const resKeys = Array.from(res.keys());

    // assert map keys
    expect(resKeys.length).toEqual(4);
    expect(resKeys.filter((x) => x.includes("gpu")).length).toEqual(0);
    expect(resKeys.filter((x) => x.includes("cpu")).length).toEqual(2);
    expect(resKeys.filter((x) => x.includes("memory")).length).toEqual(2);
    expect(resKeys.filter((x) => x.includes("max")).length).toEqual(2);
    expect(resKeys.filter((x) => x.includes("avg")).length).toEqual(2);

    // assert map values
    resKeys.forEach((key, _) => {
      expect(res.get(key)?.length).toEqual(1);
    });
  });

  it("should skip data missing ts field", () => {
    const res = flattenTS([
      TEST_DATA_3,
      {
        data: JSON.stringify({ test: "test" }),
        tags: [],
      },
    ]);
    const resKeys = Array.from(res.keys());
    // assert map keys
    expect(resKeys.length).toEqual(4);
    // assert map values
    resKeys.forEach((key, _) => {
      expect(res.get(key)?.length).toEqual(1);
    });
  });

  it("should skip data missing data field", () => {
    const res = flattenTS([
      TEST_DATA_3,
      {
        ts: "2023-10-10 18:00:00",
        data: null,
        tags: [],
      },
    ]);

    // assert
    const resKeys = Array.from(res.keys());
    // assert map keys
    expect(resKeys.length).toEqual(4);
    // assert map values
    resKeys.forEach((key, _) => {
      expect(res.get(key)?.length).toEqual(1);
    });
  });

  it("should skip data with invalid data field and logged the error", () => {
    // set up log spy to capture log messages from console.log
    const logSpy = jest.spyOn(console, "log");

    const invalidData = "{{}dsad}";
    const res = flattenTS([
      TEST_DATA_3,
      {
        ts: "2023-10-10 18:00:00",
        data: invalidData,
        tags: [],
      },
    ]);
    const resKeys = Array.from(res.keys());
    // assert map keys
    expect(resKeys.length).toEqual(4);
    // assert map values
    resKeys.forEach((key, _) => {
      expect(res.get(key)?.length).toEqual(1);
    });

    // assert log
    expect(logSpy).toHaveBeenCalledWith(
      `Warning: Error parsing JSON:SyntaxError: Expected property name or '}' in JSON at position 1 for data string '{{}dsad}'`
    );
  });
});

describe("fetchUtilization", () => {
  let mockQuery: jest.Mock;
  const mockMetadata = {
    workflow_name: "test_workflow",
    job_name: "test_job",
    collect_interval: 60,
    gpu_count: 8,
    cpu_count: 4,
    start_at: "2023-10-10 13:00:00",
    end_at: "2023-10-10 18:00:00",
    segments: [],
  };

  beforeEach(() => {
    mockQuery = jest.fn().mockImplementation((query) => {
      if (query.query.includes("oss_ci_utilization_metadata")) {
        return Promise.resolve({
          json: jest.fn().mockResolvedValue([mockMetadata]),
        });
      }
      if (query.query.includes("oss_ci_time_series")) {
        return Promise.resolve({
          json: jest.fn().mockResolvedValue(BASE_TEST_LIST),
        });
      }
    });

    (createClient as jest.Mock).mockReturnValue({
      query: mockQuery,
    });
  });

  it("should fetch data from ClickHouse", async () => {
    const param = {
      workflow_id: "1234",
      job_id: "2345",
      run_attempt: "1",
    };
    const result = await fetchUtilization(param);

    expect(result).not.toBeNull();
    expect(result!.metadata).toEqual(mockMetadata);
    expect(result!.ts_list.length).toEqual(12);
    expect(result!.ts_list[0]).toEqual({
      name: "cpu",
      id: "cpu|avg",
      records: [
        { ts: "2023-10-10 13:00:00", value: 10 },
        { ts: "2023-10-10 16:00:00", value: 20 },
      ],
    });

    // Assert query sent to clickhouse
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const firstQuery = mockQuery.mock.calls[0][0];
    expect(firstQuery.query_params).toEqual({
      workflowId: "1234",
      jobId: "2345",
      runAttempt: "1",
      repo: "pytorch/pytorch",
      type: "utilization",
    });

    expect(
      firstQuery.query.includes("oss_ci_utilization_metadata")
    ).toBeTruthy();
    const secondQuery = mockQuery.mock.calls[1][0];
    expect(secondQuery.query_params).toEqual({
      workflowId: "1234",
      jobId: "2345",
      runAttempt: "1",
      repo: "pytorch/pytorch",
      type: "utilization",
    });
    expect(secondQuery.query.includes("oss_ci_time_series")).toBeTruthy();
  });
});
