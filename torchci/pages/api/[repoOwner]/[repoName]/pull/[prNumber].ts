import { getOctokit } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";
import fetchPR from "lib/fetchPR";
import { PRData } from "lib/types";
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PRData>
) {
  const { prNumber, repoName, repoOwner } = req.query;
  const octokit = await getOctokit(repoOwner as string, repoName as string);
  res
    .status(200)
    .json(
      await fetchPR(
        repoOwner as string,
        repoName as string,
        prNumber as string,
        octokit
      )
    );
}
