import { NextApiRequest, NextApiResponse } from "next";

import { IssueData } from "lib/types";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";

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
