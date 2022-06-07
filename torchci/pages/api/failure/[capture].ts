import type { NextApiRequest, NextApiResponse } from "next";
import fetchFailureSamples from "lib/fetchFailureSamples";

interface Data {}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  const samples = await fetchFailureSamples(req.query.capture);

  const jobCount: {
    [jobName: string]: number;
  } = {};

  for (const result of samples!) {
    if (result.name !== undefined) {
      jobCount[result.name] = (jobCount[result.name] || 0) + 1;
    }
  }
  res.status(200).json({
    jobCount,
    totalCount: samples!.length,
    samples: samples!,
  });
}
