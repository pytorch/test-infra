import { readApiGetParams } from "lib/benchmark/api_helper/backend/common/utils";
import { getBenchmarkTimeSeriesData } from "lib/benchmark/api_helper/backend/get_time_series";
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
    const { name, response_formats, query_params } = params;

    const formats =
      response_formats && response_formats.length > 0
        ? response_formats
        : ["time_series"];

    const data = await getBenchmarkTimeSeriesData(name, query_params, formats);
    return res.status(200).json({ data });
  } catch (err: any) {
    console.error("API error:", err.message);
    return res.status(400).json({ error: err.message });
  }
}
