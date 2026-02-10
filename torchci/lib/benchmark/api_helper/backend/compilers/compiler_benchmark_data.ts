import {
  CommitResult,
  CompilerQueryType,
  defaultCompilerGetTimeSeriesInputs,
} from "../common/type";
import {
  emptyTimeSeriesResponse,
  getCompilerCommitsWithSampling,
} from "../common/utils";
import { BenchmarkCompilerBenchmarkDataQueryBuilder } from "../dataFetchers/queryBuilderUtils/compilerQueryBuilder";
import { extractBackendSqlStyle, toApiDeviceArch } from "./helpers/common";
import { toGeneralCompilerData } from "./helpers/general";
import { toPrecomputeCompilerData } from "./helpers/precompute";

//["x86_64","NVIDIA A10G","NVIDIA H100 80GB HBM3"]
const COMPILER_BENCHMARK_TABLE_NAME = "compilers_benchmark_api_query";
const COMPILER_BENCHMARK_COMMITS_TABLE_NAME =
  "compilers_benchmark_api_commit_query";

/**
 * backend method to get time series data
 */
export async function getCompilerBenchmarkTimeSeriesData(
  inputparams: any,
  type: CompilerQueryType,
  formats: string[] = ["time_series"]
) {
  const queryParams = await getCompilerBenchmarkTimeRangeQueryParams(
    inputparams
  );
  if (!queryParams) {
    return emptyTimeSeriesResponse();
  }
  const rows = await fetchCompilerDataFromDb(queryParams);
  if (rows.length === 0) {
    return emptyTimeSeriesResponse();
  }
  return toCompilerResponseFormat(rows, formats, type);
}

/**
 * return compiler benchmark data base on query type and formats
 * @param data
 * @param formats
 * @param type
 * @returns
 */
export function toCompilerResponseFormat(
  data: any[],
  formats: string[],
  type: string
) {
  switch (type) {
    case CompilerQueryType.PRECOMPUTE:
      return toPrecomputeCompilerData(data, formats);
    case CompilerQueryType.GENERAL:
      return toGeneralCompilerData(data, formats);
    default:
      throw new Error(`Invalid compiler query type, got ${type}`);
  }
}

export async function getCompilerCommits(
  inputParams: any
): Promise<CommitResult> {
  if (!inputParams.startTime || !inputParams.stopTime) {
    throw new Error("no start/end time provided in request");
  }
  return await getCompilerCommitsWithSampling(
    COMPILER_BENCHMARK_COMMITS_TABLE_NAME,
    inputParams
  );
}

/**
 * get list of workflows based on start/end time and other filters
 *
 * @param inputparams
 * @returns
 */
export async function getCompilerBenchmarkTimeRangeQueryParams(
  inputparams: any
) {
  const queryParams = {
    ...defaultCompilerGetTimeSeriesInputs, // base defaults
    ...inputparams, // override with caller's values
  };
  // todo(elainewy): support lworkfow and rworkflow in the future for time range query

  // use the startTime and endTime to fetch commits from clickhouse if commits field is not provided
  if (!queryParams.startTime || !queryParams.stopTime) {
    throw new Error(
      "(getCompilerBenchmarkTimeRangeQueryParams) no start/end time provided in request"
    );
  }
  if (!queryParams.workflows || queryParams.workflows.length == 0) {
    const { data: commit_results } = await getCompilerCommitsWithSampling(
      COMPILER_BENCHMARK_COMMITS_TABLE_NAME,
      queryParams
    );
    const unique_workflows = [
      ...new Set(commit_results.map((c) => c.workflow_id)),
    ];
    console.log(
      `no workflows provided in request, searched unqiue workflows based on
      start/end time unique_workflows: ${unique_workflows.length}`
    );
    if (commit_results.length > 0) {
      queryParams["workflows"] = unique_workflows;
    } else {
      console.log(`no workflow found in clickhouse using ${queryParams}`);
      return undefined;
    }
  } else {
    console.log(
      `input provided workflows found using ${queryParams.workflows}`
    );
  }
  return queryParams;
}

/**
 *
 * @param queryParams
 * @returns
 */
async function fetchCompilerDataFromDb(queryParams: any): Promise<any[]> {
  const start = Date.now();
  let rows: any[] = [];
  try {
    const fetcher = new BenchmarkCompilerBenchmarkDataQueryBuilder();
    const data = await fetcher.applyQuery(queryParams);
    rows = fetcher.postProcess(data);
  } catch (err: any) {
    throw Error(
      `${COMPILER_BENCHMARK_TABLE_NAME}(clickhouse query issue) ${err.message}`
    );
  }

  const end = Date.now();
  console.log("time to get compiler timeseris data", end - start);
  console.log("rows from clickhouse", rows[0], "total length", rows.length);
  // extract backend from output in runtime instead of doing it in the query. since it's expensive for regex matching.
  // TODO(elainewy): we should add this as a column in the database for less runtime logics.
  rows.map((row) => {
    [row["device"], row["arch"]] = toApiDeviceArch(row.device, row.arch);
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
    (row["backend"] = backend), (row["compiler"] = backend);
  });

  if (queryParams.compilers && queryParams.compilers.length > 0) {
    rows = rows.filter((row) => {
      return queryParams.compilers.includes(row.backend);
    });
  }

  if (queryParams.models && queryParams.models.length > 0) {
    rows = rows.filter((row) => {
      return queryParams.models.includes(row.model);
    });
  }

  if (queryParams.metrics && queryParams.metrics.length > 0) {
    rows = rows.filter((row) => {
      return queryParams.metrics.includes(row.metric);
    });
  }
  return rows;
}
