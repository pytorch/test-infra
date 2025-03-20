import fetchS3Links from "lib/fetchS3Links";
import { Artifact } from "lib/types";
import { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Artifact[]>
) {
  const workflowIds = (req.query.workflowId as string)
    .split(",")
    .map((id) => id.trim());
  res.status(200).json(await fetchS3Links(workflowIds));
}
