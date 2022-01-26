import type { NextApiRequest, NextApiResponse } from "next";
import fetchPR from "lib/fetchPR";
import { PRData } from "lib/types";
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PRData>
) {
  const { prNumber, repoName, repoOwner } = req.query;
  res
    .status(200)
    .json(
      await fetchPR(repoOwner as string, repoName as string, prNumber as string)
    );
}
