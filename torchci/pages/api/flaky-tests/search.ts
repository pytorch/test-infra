import { queryClickhouse } from "lib/clickhouse";
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
  const query = `
select
  t.name,
  t.classname,
  t.file,
  t.invoking_file,
  maxMerge(t.last_run) as last_run
from
  tests.distinct_names t
where
  t.name like {name: String}
  and t.classname like {suite: String}
  and t.file like {file: String}
group by
  t.name,
  t.classname,
  t.file,
  t.invoking_file
order by
  t.name, t.classname, t.file, t.invoking_file
limit
  {per_page: Int}
offset
  {offset: Int}
`;

  const count = await queryClickhouse(
    `
select
  count(distinct *) as count
from
  tests.distinct_names t
where
  t.name like {name: String}
  and t.classname like {suite: String}
  and t.file like {file: String}
`,
    {
      name: `%${name}%`,
      suite: `%${suite}%`,
      file: `%${file}%`,
    }
  );

  const result = await queryClickhouse(query, {
    name: `%${name}%`,
    suite: `%${suite}%`,
    file: `%${file}%`,
    per_page,
    offset: (page - 1) * per_page,
  });
  return {
    count: count[0].count,
    tests: result,
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
