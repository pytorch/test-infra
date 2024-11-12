import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import { IssueData } from "lib/types";
import { NextApiRequest, NextApiResponse } from "next";
import zlib from "zlib";

export type IssueLabelApiResponse = IssueData[];

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  return res
    .status(200)
    .setHeader("Cache-Control", "s-maxage=60")
    .setHeader("Content-Encoding", "gzip")
    .send(
      zlib.gzipSync(
        JSON.stringify(await fetchIssuesByLabel(req.query.label as string))
      )
    );
}
