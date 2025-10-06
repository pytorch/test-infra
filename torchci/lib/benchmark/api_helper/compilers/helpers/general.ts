import {
  to_table,
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
  "branch",
];
const COMPILER_GENERAL_TS_SUB_GROUP_KEY = ["workflow_id"];

const COMPILER_GENERAL_TABLE_GROUP_KEY = [
  "dtype",
  "arch",
  "device",
  "mode",
  "workflow_id",
  "branch",
  "compiler",
  "model",
  "suite",
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
  formats: string[] = ["time_series"]
) {
  const start_ts = new Date(rawData[0].granularity_bucket).getTime();
  const end_ts = new Date(
    rawData[rawData.length - 1].granularity_bucket
  ).getTime();

  let formats_result: any = {};

  formats.forEach((format) => {
    const data = getformat(rawData, format);
    formats_result[format] = data;
  });
  return toTimeSeriesResponse(formats_result, rawData.length, start_ts, end_ts);
}

function getformat(data: any, format: string) {
  switch (format) {
    case "time_series":
      return to_time_series_data(
        data,
        COMPILER_GENERAL_TS_GROUP_KEY,
        COMPILER_GENERAL_TS_SUB_GROUP_KEY
      );
    case "table":
      return to_table(
        data,
        COMPILER_GENERAL_TABLE_GROUP_KEY,
        COMPILER_GENERAL_TABLE_SUB_GROUP_KEY
      );
      break;
    case "raw":
      return data;
    default:
      throw new Error("Invalid type");
  }
}

export const REQUIRED_COMPLIER_LIST_COMMITS_KEYS = [
  "mode",
  "dtype",
  "deviceName",
] as const;
