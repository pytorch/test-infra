import type { NextApiRequest, NextApiResponse } from "next";
import getRocksetClient from "lib/rockset";
import rocksetVersions from "rockset/prodVersions.json";

interface Data {}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  const capture = req.query.capture;
  const rocksetClient = getRocksetClient();

  const samples = await rocksetClient.queryLambdas.executeQueryLambda(
    "commons",
    "failure_samples_query",
    rocksetVersions.commons.failure_samples_query,
    {
      parameters: [
        {
          name: "captures",
          type: "string",
          value: capture as string,
        },
      ],
    }
  );

  const jobCount: {
    [jobName: string]: number;
  } = {};

  for (const result of samples.results!) {
    jobCount[result.name] = (jobCount[result.name] || 0) + 1;
  }
  res.status(200).json({
    jobCount,
    totalCount: samples.results!.length,
    samples: samples.results!,
  });
}
