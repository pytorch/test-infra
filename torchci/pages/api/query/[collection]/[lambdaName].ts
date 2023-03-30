import type { NextApiRequest, NextApiResponse } from "next";

import getRocksetClient, { RocksetParam } from "lib/rockset";
import rocksetVersions from "rockset/prodVersions.json";

export const config = {
  api: {
    // TODO: Choose a higher limit than the 4mb default for compilers_benchmark_performance
    // and then try to figure out how to make the results smaller later
    responseLimit: "8mb",
  },
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const collection = req.query.collection as string;
  const lambdaName = req.query.lambdaName as string;
  // @ts-expect-error
  const version = rocksetVersions[collection][lambdaName];
  const parameters: RocksetParam[] = JSON.parse(req.query.parameters as string);

  const client = getRocksetClient();
  const response = await client.queryLambdas.executeQueryLambda(
    collection,
    lambdaName,
    version,
    { parameters }
  );

  res.status(200).json(response.results);
}
