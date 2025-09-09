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
import { to_table_compiler_data } from "./common";

export function toPrecomputeCompilerData(
  rawData: any[],
  inputparams: any,
  type: string = "time_series"
) {
  // get CompilerPerformanceData

  console.log("toPrecomputeCompilerData",rawData[0].granularity_bucket, rawData[rawData.length-1].granularity_bucket);

  const data = convertToCompilerPerformanceData(rawData);
  const commit_map = toWorkflowIdMap(data);

  // get precompute data
  const models = getPassingModels(data);
  const passrate = computePassrate(data, models);
  const geomean = computeGeomean(data, models);
  const peakMemory = computeMemoryCompressionRatio(data, models);

  const all_data = [passrate, geomean, peakMemory].flat();

  // post process data to get start_ts and end_ts, and add commit metadata
  const { start_ts, end_ts } = postFetchProcess(all_data, commit_map,inputparams);
  let res: any[] = [];
  switch (type) {
    case "time_series":
      res = to_time_series_data(all_data,
        ["dtype", "arch", "device", "suite", "compiler", "metric", "mode"],
        ["workflow_id"]);
      break;
    case "table":
      res = to_table_compiler_data(all_data);
      break;
  }
  return toTimeSeriesResponse(res, rawData.length, start_ts, end_ts);
}


function postFetchProcess(data: any[], commit_map: Map<string, any>, metadata:any) {
  const start_ts = new Date(data[0].granularity_bucket).getTime()
  const end_ts = new Date(data[data.length-1].granularity_bucket).getTime()
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
