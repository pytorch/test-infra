import {
  groupByBenchmarkData,
  to_time_series_data,
  toTimeSeriesResponse,
} from "../../utils";
import { toApiArch } from "./common";


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

  rawData = rawData.map((data) => {
    return {
      ...data,
      compiler: data.backend,
      arch: toApiArch(data.device, data.arch),
    };
  });
  let res: any[] = [];
  switch (type) {
    case "time_series":
      res = to_time_series_data(
        rawData,
        [
          "dtype",
          "arch",
          "device",
          "suite",
          "compiler",
          "metric",
          "mode",
          "model",
        ],
        ["workflow_id"]
      );
      break;
    case "table":
      res = groupByBenchmarkData(
        rawData,
        [
          "dtype",
          "arch",
          "device",
          "mode",
          "workflow_id",
          "granularity_bucket",
        ],
        ["metric", "compiler"]
      );
      break;
  }
  return toTimeSeriesResponse(res, rawData.length, start_ts, end_ts);
}
