import { readApiGetParams } from "lib/benchmark/api_helper/backend/common/utils";
import { listBenchmarkMetadata } from "lib/benchmark/api_helper/backend/list_metadata_api";
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

  // validate params
  if (
    !params ||
    !params.id ||
    !params.query_params ||
    Object.keys(params.query_params).length == 0 ||
    Object.keys(params).length === 0
  ) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  console.log("[API] LIST_METRICS recieved params: ", params.query_params);

  try {
    const groups = listBenchmarkMetadata(params.query_params, params.id);
    return res.status(200).json(groups);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
