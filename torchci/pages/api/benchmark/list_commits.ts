import { getCompilerCommits } from "lib/benchmark/api_helper/compilers/get_compiler_benchmark_data";
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
    const data = await getBenmarkCommits(name, query_params);
    console.log("[API]list commits, response:", data);
    if (!data) {
      return res.status(404).json({ data: {} });
    }

    const formats = response_formats ? response_formats : ["raw"];
    // format data based on requested response formats
    let result = {};
    formats.forEach((format) => {
      const f = getFormat(data, format);
      result[format] = f;
    });
    return res.status(200).json({
      data: result,
    });
  } catch (err: any) {
    console.error("API error:", err.message);
    return res.status(400).json({ error: err.message });
  }
}

async function getBenmarkCommits(request_name: string, query_params: any) {
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
      branchgroup.forEach((branch) => {
        branch["rows"] = branch.rows?.__ALL__?.data ?? [];
      });
      return branchgroup;
    case "raw":
      return data;
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}
