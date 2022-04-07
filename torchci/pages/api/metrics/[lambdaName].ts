import type { NextApiRequest, NextApiResponse } from "next";

import getRocksetClient, { RocksetParam } from "lib/rockset";
import rocksetVersions from "rockset/prodVersions.json";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const parameters: RocksetParam[] = JSON.parse(req.query.parameters as string);

  const client = getRocksetClient();
  const response = await client.queryLambdas.executeQueryLambdaByTag(
    "metrics",
    req.query.lambdaName as string,
    "latest",
    { parameters }
  );

  res.status(200).json(response.results);
}
