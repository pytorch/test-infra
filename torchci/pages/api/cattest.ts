import getRocksetClient from "lib/rockset";
import { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Array<string>>
) {
  const q = `
  select
    DISTINCT t.invoking_file
from
    commons.test_run_summary t
    join workflow_job j on j.id = t.job_id
where
    (
        t.failures > 0
        or t.errors > 0
    )
    and ARRAY_CONTAINS(SPLIT(:shas, ','), j.head_sha)
    and t._event_time > CURRENT_TIMESTAMP() - DAYS(2)
    and t.file is not null
    `;
  const rocksetClient = getRocksetClient();
  const query = await rocksetClient.queries.query({
    sql: {
      query: q,
      parameters: [
        {
          name: "shas",
          type: "string",
          value: req.query.shas as string,
        },
      ],
    },
  });

  return res
    .status(200)
    .setHeader("Cache-Control", "s-maxage=60")
    .json(query.results!);
}
