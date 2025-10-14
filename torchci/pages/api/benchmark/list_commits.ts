import { listBenchmarkCommitsFromDb } from "lib/benchmark/api_helper/backend/list_commits";
import { readApiGetParams } from "lib/benchmark/api_helper/backend/common/utils";
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
  const { name, query_params, response_formats } = params;

  try {
    const result = await listBenchmarkCommitsFromDb(
      name,
      query_params,
      response_formats
    );
    return res.status(200).json(result);
  } catch (err: any) {
    console.error("API error:", err.message);
    return res.status(400).json({ error: err.message });
  }
}
