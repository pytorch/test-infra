import { getCompilerCommits } from "../compilers/get_compiler_benchmark_data";
import { CommitResult, defaultListCommitsInputs } from "../type";
import { getCommitsWithSampling, groupByBenchmarkData } from "../utils";

const BENCHMARK_DEFAULT_LIST_COMMITS_QUERY_NAME =
  "benchmark_v3/list_commit_query";

export async function listBenchmarkCommitsFromDb(
  id: string,
  queryParams: any,
  response_formats: []
) {
  const db = await getBenmarkCommits(id, queryParams);
  if (!db) {
    console.error("No data found for", id);
    throw new Error(`No data found for ${id}`);
  }

  // get all unique branches within the time range,
  // if data is sampled, we get all branches from origin
  // otherwise we list all branches from data
  let all_branches: string[] = [];

  if (db.is_sampled) {
    all_branches = [...new Set(db.origin?.map((c: any) => c.branch))];
  } else {
    all_branches = [...new Set(db.data.map((c: any) => c.branch))];
  }

  const formats: string[] =
    response_formats && response_formats.length != 0
      ? response_formats
      : ["raw"];

  // format data based on requested response formats, for instance if format is "branch",
  //  we group the data by branch and return the data for each branch
  let result: any = {};
  formats.forEach((format) => {
    const f = getFormat(db.data, format);
    result[format] = f;
  });

  console.log(
    "[API]list commits, response data: all_branches ",
    all_branches.length
  );

  return {
    metadata: {
      branches: all_branches,
      is_samplied: db.is_sampled,
      sampling_info: db.sampling_info,
    },
    data: result,
  };
}

async function getBenmarkCommits(
  request_name: string,
  query_params: any
): Promise<CommitResult> {
  switch (request_name) {
    case "compiler":
    case "compiler_precompute":
      return await getCompilerCommits(query_params);
    default:
      return await getCommits(query_params);
  }
}

function getFormat(data: any, format: string = "raw") {
  console.log("[API]list commits, format data elaine: ", data.length);
  switch (format) {
    case "branch":
      const branchgroup = groupByBenchmarkData(data, ["branch"], []);
      branchgroup.forEach((branch: any) => {
        branch["rows"] = branch.rows?.__ALL__?.data ?? [];
      });
      return branchgroup;
    case "raw":
      return data;
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

export async function getCommits(inputparams: any) {
  if (!inputparams.repo) {
    throw new Error("no repo provided in request");
  }

  if (!inputparams.benchmarkNames || inputparams.benchmarkName) {
    throw new Error("no benchmarkNames || benchmarkName provided in request");
  }

  if (!inputparams.startTime || !inputparams.stopTime) {
    throw new Error("no start/end time provided in request");
  }

  if (inputparams.benchmarkName) {
    inputparams.benchmarkNames = [inputparams.benchmarkName];
  }
  const queryParams = {
    ...defaultListCommitsInputs, // base defaults
    ...inputparams, // override with caller's values
  };

  return await getCommitsWithSampling(
    BENCHMARK_DEFAULT_LIST_COMMITS_QUERY_NAME,
    queryParams
  );
}
