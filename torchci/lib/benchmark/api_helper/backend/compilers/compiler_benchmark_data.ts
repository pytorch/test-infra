import { queryClickhouseSaved } from "lib/clickhouse";
import {
  CommitResult,
  CompilerQueryType,
  defaultCompilerGetBenchmarkDataInputs,
  defaultCompilerGetTimeSeriesInputs,
  defaultListCommitsInputs,
} from "../common/type";
import {
  emptyTimeSeriesResponse,
  getCommitsWithSampling,
} from "../common/utils";
import {
  extractBackendSqlStyle,
  toApiArch,
  toQueryArch,
} from "./helpers/common";
import { toGeneralCompilerData } from "./helpers/general";
import { toPrecomputeCompilerData } from "./helpers/precompute";

//["x86_64","NVIDIA A10G","NVIDIA H100 80GB HBM3"]
const COMPILER_BENCHMARK_TABLE_NAME = "compilers_benchmark_api_query";
const COMPILER_BENCHMARK_COMMITS_TABLE_NAME =
  "compilers_benchmark_api_commit_query";

// TODO(ELAINEWY): add GET BENCHMARK DATA API
/**
 * backend method to get single compiler benchmark data
 * must provide workflow and branch in inputParams
 */
export async function getSingleCompilerBenchmarkData(
  request_name: string,
  inputParams: any,
  formats: string[] = ["raw"]
) {
  const queryParams = await getSingleCompilerBenchmarkDataQueryParams(
    inputParams
  );
  const rows = await fetchCompilerDataFromDb(queryParams);
  if (rows.length === 0) {
    return emptyTimeSeriesResponse();
  }
  return toCompilerResponseFormat(rows, formats, request_name);
}

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
  inputparams: any
): Promise<CommitResult> {
  if (!inputparams.startTime || !inputparams.stopTime) {
    throw new Error("no start/end time provided in request");
  }
  const queryParams = {
    ...defaultListCommitsInputs, // base defaults
    ...inputparams, // override with caller's values
  };

  const arch_list = toQueryArch(inputparams.device, inputparams.arch);
  queryParams["arch"] = arch_list;
  return await getCommitsWithSampling(
    COMPILER_BENCHMARK_COMMITS_TABLE_NAME,
    queryParams
  );
}

// TODO(ELAINEWY): add GET BENCHMARK DATA API
async function getSingleCompilerBenchmarkDataQueryParams(
  inputparams: any
): Promise<any> {
  const queryParams = {
    ...defaultCompilerGetBenchmarkDataInputs, // base defaults
    ...inputparams, // override with caller's values
  };
  const arch_list = toQueryArch(queryParams.device, queryParams.arch);
  queryParams["arch"] = arch_list;

  if (!queryParams.workflow || !queryParams.branch) {
    throw new Error(
      "no workflow or branch provided in request for single data fetch"
    );
  }
  queryParams["workflows"] = [queryParams.workflow];
  queryParams["branches"] = [queryParams.branch];
  console.log(
    "(getSingleCompilerBenchmarkDataQueryParams) workflows provided in request",
    queryParams.workflows
  );
  return queryParams;
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

  const arch_list = toQueryArch(queryParams.device, queryParams.arch);
  queryParams["arch"] = arch_list;

  // todo(elainewy): support lworkfow and rworkflow in the future for time range query

  // use the startTime and endTime to fetch commits from clickhouse if commits field is not provided
  if (!queryParams.startTime || !queryParams.stopTime) {
    throw new Error(
      "(getCompilerBenchmarkTimeRangeQueryParams) no start/end time provided in request"
    );
  }

  if (!queryParams.workflows || queryParams.workflows.length == 0) {
    const { data: commit_results } = await getCommitsWithSampling(
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
      return [];
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
    rows = await queryClickhouseSaved(
      COMPILER_BENCHMARK_TABLE_NAME,
      queryParams
    );
  } catch (err: any) {
    throw Error(
      `${COMPILER_BENCHMARK_TABLE_NAME}(clickhouse query issue) ${err.message}`
    );
  }

  const end = Date.now();
  console.log("time to get compiler timeseris data", end - start);

  if (rows.length === 0) {
    return [];
  }

  console.log("rows from clickhouse", rows[0], "total length", rows.length);
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
    (row["backend"] = backend), (row["compiler"] = backend);
    row["arch"] = toApiArch(row.device, row.arch);
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
