import {
  computeGeomean,
  computeMemoryCompressionRatio,
  computePassrate,
  convertToCompilerPerformanceData,
  getPassingModels,
} from "lib/benchmark/compilerUtils";
import {
  to_time_series_data,
  toTimeSeriesResponse,
  toWorkflowIdMap,
} from "../../utils";
import { toApiArch } from "./common";

const COMPILER_PRECOMPUTE_TS_GROUP_KEY = [
  "dtype",
  "arch",
  "device",
  "suite",
  "compiler",
  "metric",
  "mode",
];
const COMPILER_PRECOMPUTE_TS_SUB_GROUP_KEY = ["workflow_id"];

export function toPrecomputeCompilerData(
  rawData: any[],
  type: string = "time_series"
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

  let all_data = [passrate, geomean, peakMemory].flat();

  all_data = [...all_data].sort(
    (a, b) =>
      Date.parse(a.granularity_bucket) - Date.parse(b.granularity_bucket)
  );

  // post process data to get start_ts and end_ts, and add commit metadata
  const { start_ts, end_ts } = postFetchProcess(all_data, commit_map, metadata);
  let res: any[] = [];
  switch (type) {
    case "time_series":
      res = to_time_series_data(
        all_data,
        COMPILER_PRECOMPUTE_TS_GROUP_KEY,
        COMPILER_PRECOMPUTE_TS_SUB_GROUP_KEY
      );
      break;
    default:
      throw new Error("Invalid type");
  }
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
