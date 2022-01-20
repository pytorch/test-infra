import type { NextApiRequest, NextApiResponse } from "next";
import getRocksetClient from "lib/rockset";

interface Data {}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  const capture = req.query.capture;
  const rocksetClient = getRocksetClient();

  const samples = await rocksetClient.queryLambdas.executeQueryLambdaByTag(
    "commons",
    "failure_samples_query",
    "prod",
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
