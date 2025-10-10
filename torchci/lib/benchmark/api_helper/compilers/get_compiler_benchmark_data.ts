import dayjs from "dayjs";
import { queryClickhouseSaved } from "lib/clickhouse";
import {
  CommitResult,
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

    // get commits from clickhouse, if queryParams has samping config, use it
    const { data: commit_results } = await getCommitsWithSampling(
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

  let rows = [];
  try {
    rows = await queryClickhouseSaved(
      COMPILER_BENCHMARK_TABLE_NAME,
      queryParams
    );
  } catch (err: any) {
    throw Error("(clickhouse query issue) ", err.message);
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

function subsampleCommitsByDate(data: any[], maxCount: number | undefined) {
  if (!maxCount) return { data, is_sampled: false };

  if (data.length <= maxCount)
    return {
      data,
      is_sampled: false,
    };

  // Sort by date ascending
  const sorted = [...data].sort((a, b) => dayjs(a.date).diff(dayjs(b.date)));

  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  // Subsample the middle points evenly
  const step = (sorted.length - 2) / (maxCount - 2);
  const sampled = [first];

  for (let i = 1; i < maxCount - 1; i++) {
    const idx = Math.round(i * step);
    sampled.push(sorted[idx]);
  }
  sampled.push(last);

  const sampling_info = {
    origin: data.length,
    result: sampled.length,
  };
  return {
    data: sampled,
    origin: data,
    is_sampled: true,
    sampling_info,
  };
}

async function getCommitsWithSampling(
  tableName: string,
  queryParams: any
): Promise<CommitResult> {
  const commit_results = await queryClickhouseSaved(tableName, queryParams);
  let maxCount = undefined;

  // if subsampling is specified, use it
  if (queryParams.sampling) {
    maxCount = queryParams.sampling.max;
    const res = subsampleCommitsByDate(commit_results, maxCount);
    return res;
  }

  return {
    data: commit_results,
    is_sampled: false,
  };
}
