import {
  groupByBenchmarkData,
  to_time_series_data,
  toTimeSeriesResponse,
} from "../../utils";

const COMPILER_GENERAL_TS_GROUP_KEY = [
  "dtype",
  "arch",
  "device",
  "suite",
  "compiler",
  "metric",
  "mode",
  "model",
];
const COMPILER_GENERAL_TS_SUB_GROUP_KEY = ["workflow_id"];

const COMPILER_GENERAL_TABLE_GROUP_KEY = [
  "dtype",
  "arch",
  "device",
  "mode",
  "workflow_id",
  "compiler",
  "model",
];
const COMPILER_GENERAL_TABLE_SUB_GROUP_KEY = ["metric"];

/**
 * process general compiler data without precompute or aggregation
 * @param rawData
 * @param inputparams
 * @param type
 */
export function toGeneralCompilerData(
  rawData: any[],
  type: string = "time_series"
) {
  const start_ts = new Date(rawData[0].granularity_bucket).getTime();
  const end_ts = new Date(
    rawData[rawData.length - 1].granularity_bucket
  ).getTime();

  let res: any[] = [];
  switch (type) {
    case "time_series":
      res = to_time_series_data(
        rawData,
        COMPILER_GENERAL_TS_GROUP_KEY,
        COMPILER_GENERAL_TS_SUB_GROUP_KEY
      );
      break;
    case "table":
      res = groupByBenchmarkData(
        rawData,
        COMPILER_GENERAL_TABLE_GROUP_KEY,
        COMPILER_GENERAL_TABLE_SUB_GROUP_KEY
      );
      break;
    default:
      throw new Error("Invalid type");
  }
  return toTimeSeriesResponse(res, rawData.length, start_ts, end_ts);
}
