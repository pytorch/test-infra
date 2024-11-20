import { queryClickhouse } from "lib/clickhouse";
import { JobData } from "lib/types";
import _ from "lodash";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const name = req.query.name as string;
  const suite = req.query.suite as string;
  const file = req.query.file as string;
  const limit = parseInt(req.query.limit as string) || 100;

  res.status(200).json(await getFlakyTestInfo(name, suite, file, limit));
}

export interface FlakyTestInfoHUD {
  name: string;
  classname: string;
  file: string;
  invoking_file: string;
  jobs: JobData[];
}

async function getFlakyTestInfo(
  name: string,
  suite: string,
  file: string,
  limit: number
): Promise<FlakyTestInfoHUD[]> {
  const query = `
select
  t.name as name,
  t.classname as classname,
  t.file as file,
  t.invoking_file as invoking_file,
  j.conclusion as conclusion,
  j.id as job_id,
  j.name as job_name,
  j.html_url as job_url,
  j.started_at as job_started_at,
  j.torchci_classification.'line' as line,
  j.torchci_classification.'line_num' as line_num,
  j.torchci_classification.'captures' as captures,
  w.head_branch as head_branch,
  j.head_sha as head_sha
from
  default.workflow_job j
  join default.failed_test_runs t on j.id = t.job_id
  join default.workflow_run w on w.id = j.run_id
where
  t.name like {name: String}
  and t.classname like {suite: String}
  and t.file like {file: String}
group by
  t.name,
  t.classname,
  t.file,
  t.invoking_file,
  j.conclusion,
  j.id,
  j.name,
  j.html_url,
  j.started_at,
  j.torchci_classification.'line',
  j.torchci_classification.'line_num',
  j.torchci_classification.'captures',
  w.head_branch,
  j.head_sha
order by
  j.started_at desc
limit
  {limit: Int32}
`;
  const flakyTestQuery = await queryClickhouse(query, {
    name: `%${name}%`,
    suite: `%${suite}%`,
    file: `%${file}%`,
    limit: limit,
  });

  const flakyTestQueryResults = flakyTestQuery ?? [];

  const groupedByTest = _.groupBy(
    flakyTestQueryResults,
    (result) => (
      result.name, result.classname, result.file, result.invoking_file
    )
  );
  const res = [];
  for (const test of Object.values(groupedByTest)) {
    const info: FlakyTestInfoHUD = {
      name: test[0].name,
      classname: test[0].classname,
      file: test[0].file,
      invoking_file: test[0].invoking_file,
      jobs: [],
    };
    for (const row of test) {
      info.jobs.push({
        jobName: row.job_name,
        id: row.job_id,
        htmlUrl: row.job_url,
        time: row.job_started_at,
        logUrl: `https://ossci-raw-job-status.s3.amazonaws.com/log/${row.job_id}`,
        conclusion: row.conclusion,
        failureLines: [row.line],
        failureLineNumbers: [row.line_num],
        failureCaptures: [row.captures],
        branch: row.head_branch,
        sha: row.head_sha,
      });
    }
    res.push(info);
  }
  return res;
}
