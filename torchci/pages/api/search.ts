import type { NextApiRequest, NextApiResponse } from "next";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { JobData } from "lib/types";
import {
  searchSimilarFailures,
  WORKFLOW_JOB_INDEX,
  MIN_SCORE,
} from "lib/searchUtils";
import { Credentials } from "@aws-sdk/types";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ jobs: JobData[] }>
) {
  const failure = req.query.failure as string;
  const index = (req.query.index as string) ?? WORKFLOW_JOB_INDEX;
  const startDate = req.query.startDate as string;
  const endDate = req.query.endDate as string;
  // This is a weird way to satisfy TS2352
  const minScore = (req.query.minScore as unknown as number) ?? MIN_SCORE;

  // https://opensearch.org/docs/latest/clients/javascript/index
  const client = new Client({
    ...AwsSigv4Signer({
      region: process.env.OPENSEARCH_REGION as string,
      service: "es",
      getCredentials: () => {
        const credentials: Credentials = {
          accessKeyId: process.env.OUR_AWS_ACCESS_KEY_ID as string,
          secretAccessKey: process.env.OUR_AWS_SECRET_ACCESS_KEY as string,
        };
        return Promise.resolve(credentials);
      },
    }),
    node: process.env.OPENSEARCH_ENDPOINT,
  });

  res
    .status(200)
    .json(
      await searchSimilarFailures(
        client,
        failure,
        index,
        startDate,
        endDate,
        minScore
      )
    );
}
