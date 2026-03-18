import { readApiGetParams } from "lib/benchmark/api_helper/backend/common/utils";
import { getListBenchmarkMetadataFetcher } from "lib/benchmark/api_helper/backend/dataFetchers/fetchers";
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
  // validate params
  if (
    !params ||
    !params.name ||
    !params.query_params ||
    Object.keys(params.query_params).length == 0 ||
    Object.keys(params).length === 0
  ) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  console.log("[API]list metadata, received request:", params);
  try {
    const groups = await listBenchmarkMetadata(
      params.query_params,
      params.name
    );
    return res.status(200).json({ data: groups });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

async function listBenchmarkMetadata(queryParams: any, id: string) {
  // fetch metadata from db
  const fetcher = getListBenchmarkMetadataFetcher(id);
  const data = await fetcher.applyQuery(queryParams);
  const result = fetcher.postProcess(data);
  return result;
}
