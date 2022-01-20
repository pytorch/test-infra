import { NextApiRequest, NextApiResponse } from "next";

import getRocksetClient from "lib/rockset";
import { IssueData } from "lib/types";
interface Data {
  issues: IssueData[];
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  const rocksetClient = getRocksetClient();
  const label = req.query.label;

  const query = await rocksetClient.queryLambdas.executeQueryLambdaByTag(
    "commons",
    "issue_query",
    "prod",
    {
      parameters: [
        {
          name: "label",
          type: "string",
          value: label as string,
        },
      ],
    }
  );
  const issues = query.results! as IssueData[];
  return res
    .status(200)
    .setHeader("Cache-Control", "s-maxage=60")
    .json({ issues });
}
