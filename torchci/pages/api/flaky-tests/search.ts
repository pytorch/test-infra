import { queryClickhouseSaved } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ListTestInfoAPIResponse>
) {
  const name = req.query.name as string;
  const suite = req.query.suite as string;
  const file = req.query.file as string;
  const per_page = parseInt(req.query.per_page as string) || 100;
  const page = parseInt(req.query.page as string) || 1;

  res.status(200).json(await listTests(name, suite, file, per_page, page));
}

async function listTests(
  name: string,
  suite: string,
  file: string,
  per_page: number,
  page: number
): Promise<ListTestInfoAPIResponse> {
  const count = queryClickhouseSaved("testStatsDistinctCount", {
    name: `%${name}%`,
    suite: `%${suite}%`,
    file: `%${file}%`,
  });

  const result = queryClickhouseSaved("testStatsSearch", {
    name: `%${name}%`,
    suite: `%${suite}%`,
    file: `%${file}%`,
    per_page,
    offset: (page - 1) * per_page,
  });

  return {
    count: (await count)[0].count,
    tests: await result,
  };
}

export interface ListTestInfoAPIResponse {
  count: number;
  tests: {
    name: string;
    classname: string;
    file: string;
    invoking_file: string;
    last_run: string;
  }[];
}
