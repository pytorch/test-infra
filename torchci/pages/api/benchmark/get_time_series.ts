import { getCompilerBenchmarkData } from "lib/benchmark/api_helper/compilers/precompute";
import { readApiGetParams } from "lib/benchmark/api_helper/utils";
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * API Route: /api/benchmark/get_time_series
 *  Fetch benchmark time series data (e.g., compiler performance).
 *  currently only support compiler_precompute
 *
 * Supported Methods:
 *   - GET  : Pass parameters via query string
 *            Example:
 *              /api/benchmark/get_time_series?parameters={"name":"compiler_precompute","query_params":{...}}
 *   - POST : Pass parameters in JSON body
 *            Example:
 *              {
 *                "name": "compiler_precompute",
 *                "query_params": { ... }
 *              }
 **/
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Only GET and POST allowed" });
  }

  const params = readApiGetParams(req);
  console.log("[API]get_time_series, received request:", params);

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
    const { name, query_params } = params;
    const data = await getBenmarkTimeSeriesData(name, query_params);
    return res.status(200).json({ data });
  } catch (err: any) {
    console.error("API error:", err.message);
    return res.status(400).json({ error: err.message });
  }
}

async function getBenmarkTimeSeriesData(
  request_name: string,
  query_params: any
) {
  switch (request_name) {
    case "compiler_precompute":
      return await getCompilerBenchmarkData(query_params);
    default:
      throw new Error(`Unsupported request_name: ${request_name}`);
  }
}
