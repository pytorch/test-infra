import { queryClickhouseSaved } from "lib/clickhouse";
import {
  CompilerQueryType,
  defaultGetTimeSeriesInputs,
  defaultListCommitsInputs,
} from "../type";
import { emptyTimeSeriesResponse } from "../utils";
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

export async function getCompilerBenchmarkData(
  inputparams: any,
  type: CompilerQueryType = CompilerQueryType.PRECOMPUTE,
  formats: string[] = ["time_series"]
) {
  const rows = await getCompilerDataFromClickhouse(inputparams);

  if (rows.length === 0) {
    return emptyTimeSeriesResponse();
  }

  switch (type) {
    case CompilerQueryType.PRECOMPUTE:
      return toPrecomputeCompilerData(rows, formats);
    case CompilerQueryType.GENERAL:
      return toGeneralCompilerData(rows, formats);
    default:
      throw new Error(`Invalid compiler query type, got ${type}`);
  }
}

export async function getCompilerCommits(inputparams: any): Promise<any[]> {
  if (!inputparams.startTime || !inputparams.stopTime) {
    throw new Error("no start/end time provided in request");
  }
  const queryParams = {
    ...defaultListCommitsInputs, // base defaults
    ...inputparams, // override with caller's values
  };

  const arch_list = toQueryArch(inputparams.device, inputparams.arch);
  queryParams["arch"] = arch_list;

  const commit_results = await queryClickhouseSaved(
    COMPILER_BENCHMARK_COMMITS_TABLE_NAME,
    queryParams
  );
  return commit_results;
}

async function getCompilerDataFromClickhouse(inputparams: any): Promise<any[]> {
  const start = Date.now();

  const queryParams = {
    ...defaultGetTimeSeriesInputs, // base defaults
    ...inputparams, // override with caller's values
  };

  const arch_list = toQueryArch(queryParams.device, queryParams.arch);
  queryParams["arch"] = arch_list;

  // use the startTime and endTime to fetch commits from clickhouse if commits field is not provided
  if (!queryParams.commits || queryParams.commits.length == 0) {
    if (!queryParams.startTime || !queryParams.stopTime) {
      console.log("no commits or start/end time provided in request");
      return [];
    }

    // get commits from clickhouse
    const commit_results = await queryClickhouseSaved(
      COMPILER_BENCHMARK_COMMITS_TABLE_NAME,
      queryParams
    );
    // get unique commits
    const unique_commits = [...new Set(commit_results.map((c) => c.commit))];
    if (unique_commits.length === 0) {
      console.log("no commits found in clickhouse using", queryParams);
      return [];
    }

    console.log(
      `no commits provided in request, searched unqiue commits based on
      start/end time unique_commits: ${unique_commits.length}`
    );

    if (commit_results.length > 0) {
      queryParams["commits"] = unique_commits;
    } else {
      console.log(`no commits found in clickhouse using ${queryParams}`);
      return [];
    }
  } else {
    console.log("commits provided in request", queryParams.commits);
  }

  let rows = await queryClickhouseSaved(
    COMPILER_BENCHMARK_TABLE_NAME,
    queryParams
  );
  const end = Date.now();
  console.log("time to get compiler timeseris data", end - start);

  if (rows.length === 0) {
    return [];
  }

  console.log("rows from clickhouse", rows[0]);

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

  if (inputparams.compilers && inputparams.compilers.length > 0) {
    rows = rows.filter((row) => {
      return inputparams.compilers.includes(row.backend);
    });
  }

  if (inputparams.models && inputparams.models.length > 0) {
    rows = rows.filter((row) => {
      return inputparams.models.includes(row.model);
    });
  }

  if (inputparams.metrics && inputparams.metrics.length > 0) {
    rows = rows.filter((row) => {
      return inputparams.metrics.includes(row.metric);
    });
  }
  return rows;
}
