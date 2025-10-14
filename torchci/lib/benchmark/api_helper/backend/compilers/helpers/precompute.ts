import {
  computeCompilationTime,
  computeExecutionTime,
  computeGeomean,
  computeMemoryCompressionRatio,
  computePassrate,
  computePeakMemoryUsage,
  convertToCompilerPerformanceData,
  getPassingModels,
} from "lib/benchmark/compilerUtils";
import {
  to_table,
  to_time_series_data,
  toTimeSeriesResponse,
  toWorkflowIdMap,
} from "../../common/utils";
import { toApiArch } from "./common";

const COMPILER_PRECOMPUTE_TS_GROUP_KEY = [
  "dtype",
  "arch",
  "device",
  "suite",
  "compiler",
  "metric",
  "mode",
  "branch",
];
const COMPILER_PRECOMPUTE_TS_SUB_GROUP_KEY = ["workflow_id"];

const COMPILER_PRECOMPUTE_TABLE_GROUP_KEY = [
  "dtype",
  "arch",
  "device",
  "mode",
  "workflow_id",
  "commit",
  "branch",
  "granularity_bucket",
  "metric",
  "compiler",
];
const COMPILER_PRECOMPUTE_TABLE_SUB_GROUP_KEY = ["suite"];

export function toPrecomputeCompilerData(
  rawData: any[],
  formats: string[] = ["time_series"]
) {
  const metadata = {
    dtype: rawData[0].dtype,
    arch: toApiArch(rawData[0].device, rawData[0].arch),
    mode: rawData[0].mode,
    device: rawData[0].device,
  };

  // get CompilerPerformanceData
  const data = convertToCompilerPerformanceData(rawData);
  const commit_map = toWorkflowIdMap(data);

  // get precompute data
  const models = getPassingModels(data);
  const passrate = computePassrate(data, models);
  const geomean = computeGeomean(data, models);
  const peakMemory = computeMemoryCompressionRatio(data, models);
  const compilationTime = computeCompilationTime(data, models);
  const executionTime = computeExecutionTime(data, models);
  const peakMemoryUsage = computePeakMemoryUsage(data, models);

  let all_data = [
    passrate,
    geomean,
    peakMemory,
    compilationTime,
    executionTime,
    peakMemoryUsage,
  ].flat();

  all_data = [...all_data].sort(
    (a, b) =>
      Date.parse(a.granularity_bucket) - Date.parse(b.granularity_bucket)
  );

  // post process data to get start_ts and end_ts, and add commit metadata
  const { start_ts, end_ts } = postFetchProcess(all_data, commit_map, metadata);

  let res: any = {};
  formats.forEach((format) => {
    const f = getFormat(all_data, format);
    res[format] = f;
  });
  return toTimeSeriesResponse(res, rawData.length, start_ts, end_ts);
}

function postFetchProcess(
  data: any[],
  commit_map: Map<string, any>,
  metadata: any
) {
  const start_ts = new Date(data[0].granularity_bucket).getTime();
  const end_ts = new Date(data[data.length - 1].granularity_bucket).getTime();
  data.map((row) => {
    row["commit"] = commit_map.get(row.workflow_id)?.commit;
    row["branch"] = commit_map.get(row.workflow_id)?.branch;

    row["dtype"] = metadata["dtype"];
    row["arch"] = metadata["arch"];
    row["device"] = metadata["device"];
    row["mode"] = metadata["mode"];
  });

  return {
    start_ts,
    end_ts,
  };
}

function getFormat(data: any, format: string) {
  switch (format) {
    case "time_series":
      return to_time_series_data(
        data,
        COMPILER_PRECOMPUTE_TS_GROUP_KEY,
        COMPILER_PRECOMPUTE_TS_SUB_GROUP_KEY
      );
      break;
    case "table":
      return to_table(
        data,
        COMPILER_PRECOMPUTE_TABLE_GROUP_KEY,
        COMPILER_PRECOMPUTE_TABLE_SUB_GROUP_KEY
      );
      break;
    case "raw":
      return data;
      break;
    default:
      throw new Error("Invalid type");
  }
}
