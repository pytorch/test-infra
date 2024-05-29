import { getOpenSearchClient } from "lib/opensearch";
import {
  MIN_SCORE,
  searchSimilarFailures,
  WORKFLOW_JOB_INDEX,
} from "lib/searchUtils";
import { JobData } from "lib/types";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ jobs: JobData[] }>
) {
  const failure = req.query.failure as string;
  const workflowName = (req.query.workflowName as string) ?? "";
  const branchName = (req.query.branchName as string) ?? "";
  const index = (req.query.index as string) ?? WORKFLOW_JOB_INDEX;
  const startDate = req.query.startDate as string;
  const endDate = req.query.endDate as string;
  // This is a weird way to satisfy TS2352
  const minScore = (req.query.minScore as unknown as number) ?? MIN_SCORE;

  // https://opensearch.org/docs/latest/clients/javascript/index
  const client = getOpenSearchClient();

  res
    .status(200)
    .json(
      await searchSimilarFailures(
        client,
        failure,
        workflowName,
        branchName,
        index,
        startDate,
        endDate,
        minScore
      )
    );
}
