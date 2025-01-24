import { queryClickhouseSaved } from "lib/clickhouse";
import _ from "lodash";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<TestInfoAPIResponse>
) {
  const name = req.query.name as string;
  const suite = req.query.suite as string;
  const file = req.query.file as string;
  const jobFilter = req.query.jobFilter as string;
  res.status(200).json(await getTest(name, suite, file, jobFilter));
}

async function getTest(
  name: string,
  suite: string,
  file: string,
  jobFilter: string
): Promise<TestInfoAPIResponse> {
  jobFilter = `%${jobFilter}%`;

  const res = await queryClickhouseSaved("testStats3d", {
    name,
    suite,
    file,
    jobFilter,
  });

  for (const row of res) {
    row.conclusions = _.countBy(row.conclusions);
  }
  return res;
}

export type TestInfoAPIResponse = {
  hour: string;
  conclusions: { [key: string]: number };
}[];
