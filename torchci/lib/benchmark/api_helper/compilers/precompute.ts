import {
  computeGeomean,
  computePassrate,
  computePeakMemoryUsage,
  convertToCompilerPerformanceData,
  getPassingModels,
} from "lib/benchmark/compilerUtils";
import { queryClickhouseSaved } from "lib/clickhouse";
import { BenchmarkTimeSeriesResponse, groupByBenchmarkData } from "../utils";

const BENCNMARK_TABLE_NAME = "compilers_benchmark_performance";

// TODO(elainewy): improve the fetch performance
export async function getCompilerBenchmarkData(inputparams: any) {
  const start = Date.now();
  const rows = await queryClickhouseSaved(BENCNMARK_TABLE_NAME, inputparams);
  const end = Date.now();

  // TODO(elainewy): add logics to handle the case to return raw data
  const benchmark_time_series_response = toPrecomputeCompiler(
    rows,
    inputparams,
    "time_series"
  );
  console.log("time to get data", end - start);
  return benchmark_time_series_response;
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

  const earliest_timestamp = Math.min(
    ...all_data.map((row) => new Date(row.granularity_bucket).getTime())
  );
  const latest_timestamp = Math.max(
    ...all_data.map((row) => new Date(row.granularity_bucket).getTime())
  );

  //TODO(elainewy): remove this after change the schema of compiler database to populate the fields directly
  all_data.map((row) => {
    row["dtype"] = inputparams["dtype"];
    row["arch"] = inputparams["arch"];
    row["device"] = inputparams["device"];
    row["mode"] = inputparams["mode"];
  });

  let res: any[] = [];
  switch (type) {
    case "time_series":
      /**
       * Response of groupByBenchmarkData:
       * [
       *   {
       *     "group_info": {
       *       "dtype": "fp32",
       *       "arch": "sm80",
       *       "device": "cuda",
       *       "suite": "ads_10x",
       *       "compiler": "gcc9.3.0",
       *       "metric": "latency",
       *       "mode": "eager"
       *     },
       *     "rows": [
       *        "f123456": {
       *          "group_info": {
       *           "workflow_id": "f123456"
       *          },
       *          "data": [ # list of data that has the same group_info for group keys and sub group keys
       *           {
       *             "workflow_id": "f123456",
       *             "granularity_bucket": "2022-10-01 00:00:00",
       *             "value": 100
       *             ...
       *           }
       *         ],
       *       },
       *     ]
       *   }
       * ]
       */
      const tsd = groupByBenchmarkData(
        all_data,
        ["dtype", "arch", "device", "suite", "compiler", "metric", "mode"],
        ["workflow_id"]
      );

      res = tsd.map((group) => {
        const group_info = group.group_Info;
        const sub_group_data = group.rows;
        // extract the first data point for each sub group
        // since we only have one datapoint for each unique workflow id with the same group info
        const ts_list = Object.values(sub_group_data)
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
          data: ts_list,
        };
      });
      break;
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
      break;
  }

  const response: BenchmarkTimeSeriesResponse = {
    time_series: res,
    time_range: {
      start: new Date(earliest_timestamp).toISOString(),
      end: new Date(latest_timestamp).toISOString(),
    },
  };
  return response;
}
