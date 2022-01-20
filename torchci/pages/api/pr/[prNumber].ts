import type { NextApiRequest, NextApiResponse } from "next";
import fetchPR from "lib/fetchPR";
import { PRData } from "lib/types";
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PRData>
) {
  res.status(200).json(await fetchPR(req.query.prNumber as string));
}
