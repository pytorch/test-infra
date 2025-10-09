import { getCompilerCommits } from "lib/benchmark/api_helper/compilers/get_compiler_benchmark_data";
import { CommitResult } from "lib/benchmark/api_helper/type";
import {
  groupByBenchmarkData,
  readApiGetParams,
} from "lib/benchmark/api_helper/utils";
import { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Only GET and POST allowed" });
  }

  const params = readApiGetParams(req);
  console.log("[API]list commits, received request:", params);

  // validate params
  if (
    !params ||
    !params.query_params ||
    Object.keys(params.query_params).length == 0 ||
    Object.keys(params).length === 0
  ) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  // get time series data
  try {
    const { name, query_params, response_formats } = params;
    const db = await getBenmarkCommits(name, query_params);
    if (!db) {
      console.error("No data found for", name);
      return res.status(404).json({ data: {} });
    }

    // get all unique branches within the time range,
    // if data is sampled, we get all branches from origin
    // otherwise we list all branches from data
    let all_branches: string[] = [];

    if (db.is_sampled) {
      all_branches = [...new Set(db.origin?.map((c) => c.branch))];
    } else {
      all_branches = [...new Set(db.data.map((c) => c.branch))];
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

    console.log("[API]list commits, response data: all_branches ", all_branches.length, " result: ",result);

    return res.status(200).json({
      metadata: {
        branches: all_branches,
        is_samplied: db.is_sampled,
        sampling_info: db.sampling_info,
      },
      data: result,
    });
  } catch (err: any) {
    console.error("API error:", err.message);
    return res.status(400).json({ error: err.message });
  }
}

async function getBenmarkCommits(request_name: string, query_params: any): Promise<CommitResult> {
  switch (request_name) {
    case "compiler":
    case "compiler_precompute":
      return await getCompilerCommits(query_params);
    default:
      throw new Error(`Unsupported request_name: ${request_name}`);
  }
}

function getFormat(data: any, format: string = "raw") {
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
