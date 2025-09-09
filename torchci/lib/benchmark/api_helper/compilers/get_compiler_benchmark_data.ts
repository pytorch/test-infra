import { queryClickhouseSaved } from "lib/clickhouse";
import { emptyTimeSeriesResponse } from "../utils";
import { extractBackendSqlStyle, toApiArch, toQueryArch } from "./helpers/common";
import { toGeneralCompilerData } from "./helpers/general";
import { toPrecomputeCompilerData } from "./helpers/precompute";
import { CompilerQueryType } from "./type";
//["x86_64","NVIDIA A10G","NVIDIA H100 80GB HBM3"]
const COMPILER_BENCHMARK_TABLE_NAME = "compilers_benchmark_api_query";

export async function getCompilerBenchmarkData(
  inputparams: any,
  type: CompilerQueryType = CompilerQueryType.PRECOMPUTE
) {
  let table = COMPILER_BENCHMARK_TABLE_NAME;
  // query from clickhouse
  const start = Date.now();

  const arch_list = toQueryArch(inputparams.device, inputparams.arch)
  inputparams["arch"] = arch_list;

  let rows = await queryClickhouseSaved(table, inputparams);
  const end = Date.now();
  console.log("time to get compiler timeseris data", end - start);

  if (rows.length === 0) {
    return emptyTimeSeriesResponse();
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
            row.dtype,
            row.mode,
            row.device
          );
    row["backend"] = backend;
  });

  // currently we only support single device and single arch
  const metadata = {
    dtype: rows[0].dtype,
    arch:  toApiArch(rows[0].device, rows[0].arch),
    mode: rows[0].mode,
    device: rows[0].device
  }

  switch (type) {
    case CompilerQueryType.PRECOMPUTE:
      return toPrecomputeCompilerData(rows, metadata, "time_series");
    case CompilerQueryType.GENERAL:
      return toGeneralCompilerData(rows, "time_series");
    default:
      throw new Error(`Invalid compiler query type, got ${type}`);
  }
}
