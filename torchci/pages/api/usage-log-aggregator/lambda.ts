import * as restc from "typed-rest-client/RestClient";
import { TestInsightsUsageData } from "lib/types";
import { NextApiRequest, NextApiResponse } from "next";

const USAGE_LOG_AGGREGATOR_API = "https://0y7izelft6.execute-api.us-east-1.amazonaws.com/default/usage-log-aggregator"

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const client = new restc.RestClient(null);
  const response = await client.create<TestInsightsUsageData>(USAGE_LOG_AGGREGATOR_API, JSON.parse(req.query.params as string));
  res.status(response.statusCode).json(response.result);
}

