import type { NextApiRequest, NextApiResponse } from "next";
import fetchCommit from "lib/fetchCommit";
import { CommitData } from "lib/types";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CommitData>
) {
  res.status(200).json(await fetchCommit(req.query.sha as string));
}
