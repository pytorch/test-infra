import {
  computeGeomean,
  computePassrate,
  computePeakMemoryUsage,
  convertToCompilerPerformanceData,
  getPassingModels,
} from "lib/benchmark/compilerUtils";
import { queryClickhouseSaved } from "lib/clickhouse";
import { groupByBenchmarkData } from "../utils";

const BENCNMARK_TABLE_NAME = "compilers_benchmark_performance";

// TODO(elainewy): improve the fetch performance
export async function getCompilerBenchmarkData(inputparams: any) {
  const start = Date.now();
  const rows = await queryClickhouseSaved(BENCNMARK_TABLE_NAME, inputparams);
  const end = Date.now();

  // TODO(elainewy): add logics to handle the case to return raw data
  const result = toPrecomputeCompiler(rows, inputparams, "time_series");
  console.log("time to get data", end - start);
  return result;
}

function toPrecomputeCompiler(
  rawData: any[],
  inputparams: any,
  type: string = "time_series"
) {
  const data = convertToCompilerPerformanceData(rawData);
  const models = getPassingModels(data);

  const passrate = computePassrate(data, models);
  const geomean = computeGeomean(data, models);
  const peakMemory = computePeakMemoryUsage(data, models);

  const all_data = [passrate, geomean, peakMemory].flat();

  all_data.map((row) => {
    row["dtype"] = inputparams["dtype"];
    row["arch"] = inputparams["arch"];
    row["device"] = inputparams["device"];
    row["mode"] = inputparams["mode"];
  });

  let res: any[] = [];
  switch (type) {
    case "time_series":
      // grouping data by comipler, device, arch, dtype, suite, metric, mode
      // then sorted it with granularity_bucket in ascending order
      const tsd = groupByBenchmarkData(
        all_data,
        ["dtype", "arch", "device", "suite", "compiler", "metric", "mode"],
        ["workflow_id"]
      );
      res = tsd.map((group) => {
        const group_info = group.group_Info;
        const group_data = group.rows;

        // no need for the group_info for subgroup, directly get the data
        const ts_list = Object.values(group_data)
          .filter((item) => item.data.length > 0)
          .map((item) => item.data[0])
          .sort(
            (a, b) =>
              new Date(a.granularity_bucket).getTime() -
              new Date(b.granularity_bucket).getTime()
          );
        return {
          group_info,
          num_of_dp: ts_list.length,
          result: ts_list,
        };
      });
      return res;
    case "table":
      res = groupByBenchmarkData(
        all_data,
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
  }

  return res;
}
