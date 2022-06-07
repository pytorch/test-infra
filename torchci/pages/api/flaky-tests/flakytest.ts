import type { NextApiRequest, NextApiResponse } from "next";
import { fetchFlakyTestHistory } from "lib/fetchFlakyTests";
import { FlakyTestData } from "lib/types";

interface Data {}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  const name = req.query.name;
  const suite = req.query.suite;
  const file = req.query.file;

  const flakyTests: FlakyTestData[] = await fetchFlakyTestHistory(
    name as string,
    suite as string,
    file as string
  );

  res.status(200).json({ flakyTests });
}
