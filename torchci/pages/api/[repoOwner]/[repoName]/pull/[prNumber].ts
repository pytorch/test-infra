import fetchPR from "lib/fetchPR";
import { getOctokit } from "lib/github";
import { PRData } from "lib/types";
import type { NextApiRequest, NextApiResponse } from "next";
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PRData>
) {
  const { prNumber, repoName, repoOwner, use_ch } = req.query;
  const octokit = await getOctokit(repoOwner as string, repoName as string);
  res
    .status(200)
    .json(
      await fetchPR(
        repoOwner as string,
        repoName as string,
        prNumber as string,
        octokit,
        use_ch === "true"
      )
    );
}
