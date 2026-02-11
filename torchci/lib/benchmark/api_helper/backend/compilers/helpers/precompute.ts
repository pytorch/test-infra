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
  emptyTimeSeriesResponse,
  to_table,
  to_time_series_data,
  toTimeSeriesResponse,
  toWorkflowIdMap,
} from "../../common/utils";
import { toApiDeviceArch } from "./common";

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

function toPrecomputeCompilerDataPerGroup(rawData: any[], metadata: any) {
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

  let processed = [
    passrate,
    geomean,
    peakMemory,
    compilationTime,
    executionTime,
    peakMemoryUsage,
  ].flat();

  addMetadata(processed, commit_map, metadata);

  // only show export for passrate
  processed = processed.filter((row) =>
    row.compiler == "export" && row.metric != "passrate" ? false : true
  );
  return processed;
}

export function toPrecomputeCompilerData(
  rawData: any[],
  formats: string[] = ["time_series"]
) {
  const { groups, metadataMapping } = groupByBenchmark(rawData);

  let all_data: any[] = [];
  for (const [key, items] of Object.entries(groups)) {
    console.log("Per group info:", key);
    const meta = metadataMapping[key];
    const dataPerGroup = toPrecomputeCompilerDataPerGroup(items, meta);
    all_data = [...all_data, ...dataPerGroup];
  }
  // Sort data by granularity_bucket
  const sortedData = [...all_data].sort(
    (a, b) =>
      Date.parse(a.granularity_bucket) - Date.parse(b.granularity_bucket)
  );
  if (!sortedData || sortedData.length === 0) {
    return emptyTimeSeriesResponse();
  }

  // post process data to get start_ts and end_ts using SORTED data
  const { start_ts, end_ts } = postFetchProcess(sortedData);
  let res: any = {};
  formats.forEach((format) => {
    const f = getFormat(sortedData, format);
    res[format] = f;
  });
  return toTimeSeriesResponse(res, rawData.length, start_ts, end_ts);
}

function addMetadata(data: any[], commit_map: Map<string, any>, metadata: any) {
  data.map((row) => {
    row["commit"] = commit_map.get(row.workflow_id)?.commit;
    row["branch"] = commit_map.get(row.workflow_id)?.branch;
    row["dtype"] = metadata["dtype"];
    row["arch"] = metadata["arch"];
    row["device"] = metadata["device"];
    row["mode"] = metadata["mode"];
  });
}

function postFetchProcess(data: any[]) {
  // data is expected to be sorted by granularity_bucket
  let start_ts = new Date(data[0]?.granularity_bucket).getTime();
  let end_ts = new Date(data[data.length - 1]?.granularity_bucket).getTime();
  // Handle invalid dates (NaN from getTime)
  if (isNaN(start_ts) || isNaN(end_ts)) {
    console.warn(
      "(postFetchProcess) Invalid granularity_bucket values detected"
    );
    throw new Error(
      `(postFetchProcess)Invalid granularity_bucket values detected peek first data: ${data[0]}`
    );
  }
  // Swap if needed (safety check)
  if (end_ts < start_ts) {
    [start_ts, end_ts] = [end_ts, start_ts];
  }
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

export function groupByBenchmark(rawData: any[]) {
  const groups: Record<string, any[]> = {};
  const metadataMapping: Record<string, any> = {};
  for (const item of rawData) {
    const [apiDevice, apiArch] = toApiDeviceArch(item.device, item.arch);
    // composite grouping key
    const key = `${apiArch}_${apiDevice}_${item.dtype}_${item.mode}`;
    if (!metadataMapping[key]) {
      metadataMapping[key] = {
        dtype: item.dtype,
        arch: apiArch,
        mode: item.mode,
        device: apiDevice,
      };
    }
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(item);
  }

  return { groups, metadataMapping };
}
