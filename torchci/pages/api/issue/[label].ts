import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import { IssueData } from "lib/types";
import { NextApiRequest, NextApiResponse } from "next";

interface Data {
  issues: IssueData[];
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  return res
    .status(200)
    .setHeader("Cache-Control", "s-maxage=60")
    .json({ issues: await fetchIssuesByLabel(req.query.label as string) });
}
