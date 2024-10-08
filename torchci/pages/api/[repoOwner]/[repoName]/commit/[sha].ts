import fetchCommit from "lib/fetchCommit";
import { CommitData, JobData } from "lib/types";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ commit: CommitData; jobs: JobData[] }>
) {
  res
    .status(200)
    .json(
      await fetchCommit(
        req.query.repoOwner as string,
        req.query.repoName as string,
        req.query.sha as string,
        req.query.use_ch === "true"
      )
    );
}
