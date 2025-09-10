import {
  computeGeomean,
  computeMemoryCompressionRatio,
  computePassrate,
  convertToCompilerPerformanceData,
  getPassingModels,
} from "lib/benchmark/compilerUtils";
import { queryClickhouseSaved } from "lib/clickhouse";
import { CompilerPerformanceData } from "lib/types";
import { BenchmarkTimeSeriesResponse, groupByBenchmarkData } from "../utils";
//["x86_64","NVIDIA A10G","NVIDIA H100 80GB HBM3"]
const COMPILER_BENCHMARK_TABLE_NAME = "compilers_benchmark_api_query";

// TODO(elainewy): improve the fetch performance
export async function getCompilerBenchmarkData(
  inputparams: any,
  query_table: string = ""
) {
  let table = COMPILER_BENCHMARK_TABLE_NAME;
  if (query_table.length > 0) {
    table = query_table;
  }

  const start = Date.now();
  let rows = await queryClickhouseSaved(table, inputparams);
  const end = Date.now();
  console.log("time to get compiler timeseris data", end - start);

  if (rows.length === 0) {
    const response: BenchmarkTimeSeriesResponse = {
      total_rows: 0,
      time_series: [],
      time_range: {
        start: "",
        end: "",
      },
    };
    return response;
  }

  // extract backend from output in runtime instead of doing it in the query. since it's expensive for regex matching.
  // TODO(elainewy): we should add this as a column in the database for less runtime logics.
  rows.map((row) => {
    const backend =
      row.backend && row.backend !== ""
        ? row.backend
        : extractBackendSqlStyle(
            row.output,
            row.suite,
            inputparams.dtype,
            inputparams.mode,
            inputparams.device
          );
    row["backend"] = backend;
  });

  // TODO(elainewy): add logics to handle the case to return raw data
  const benchmark_time_series_response = toPrecomputeCompiler(
    rows,
    inputparams,
    "time_series"
  );
  return benchmark_time_series_response;
}

function toPrecomputeCompiler(
  rawData: any[],
  inputparams: any,
  type: string = "time_series"
) {
  const data = convertToCompilerPerformanceData(rawData);
  const commit_map = toWorkflowIdMap(data);
  const models = getPassingModels(data);
  const passrate = computePassrate(data, models);
  const geomean = computeGeomean(data, models);
  const peakMemory = computeMemoryCompressionRatio(data, models);

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
    row["commit"] = commit_map.get(row.workflow_id)?.commit;
    row["branch"] = commit_map.get(row.workflow_id)?.branch;
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
    total_rows: res.length,
    total_raw_rows: rawData.length,
    time_range: {
      start: new Date(earliest_timestamp).toISOString(),
      end: new Date(latest_timestamp).toISOString(),
    },
    time_series: res,
  };
  return response;
}

export function extractBackendSqlStyle(
  output: string,
  suite: string,
  dtype: string,
  mode: string,
  device: string
): string | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = `_${esc(suite)}_${esc(dtype)}_${esc(mode)}_${esc(device)}_`;

  const temp = output.replace(new RegExp(`${tail}.*$`), "");

  const m = temp.match(/.*[\/\\]([^\/\\]+)$/);
  return m ? m[1] : null;
}

export function toWorkflowIdMap(data: CompilerPerformanceData[]) {
  const commit_map = new Map<string, any>();
  data.forEach((row) => {
    const commit = row?.commit;
    const branch = row?.branch;
    const workflow_id = `${row.workflow_id}`;
    commit_map.set(workflow_id, {
      commit,
      branch,
      workflow_id,
    });
  });
  return commit_map;
}
