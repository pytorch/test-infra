import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import { IssueData } from "lib/types";
import { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<IssueData[]>
) {
  return res
    .status(200)
    .setHeader("Cache-Control", "s-maxage=60")
    .json(await fetchIssuesByLabel(req.query.label as string));
}
