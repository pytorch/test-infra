import getRocksetClient from "lib/rockset";
import rocksetVersions from "rockset/prodVersions";

import { JobData } from "./types";

export default async function fetchFailureSamples(
  capture: string | string[]
): Promise<JobData[]> {
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
  return samples.results ?? [];
}
