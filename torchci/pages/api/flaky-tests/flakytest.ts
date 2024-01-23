import type { NextApiRequest, NextApiResponse } from "next";
import { JobData } from "lib/types";
import getRocksetClient from "lib/rockset";
import _ from "lodash";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const name = req.query.name as string;
  const suite = req.query.suite as string;
  const file = req.query.file as string;

  res.status(200).json(await getFlakyTestInfo(name, suite, file));
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
  file: string
): Promise<FlakyTestInfoHUD[]> {
  const query = `
  select
  t.name,
  t.classname,
  t.file,
  t.invoking_file,
  j.conclusion,
  j.id as job_id,
  j.name as job_name,
  j.html_url as job_url,
  j.started_at as job_started_at,
  j.torchci_classification.line,
  j.torchci_classification.line_num,
  j.torchci_classification.captures
from
  workflow_job j
  join commons.failed_tests_run t on j.id = t.job_id HINT(join_strategy = lookup)
where
  t.name like :name
  and t.classname like :suite
  and t.file like :file
  and j.name not like '%rerun_disabled_tests%'
order by
  PARSE_TIMESTAMP_ISO8601(j.started_at) desc
limit
  100
  `;
  const rocksetClient = getRocksetClient();
  const flakyTestQuery = await rocksetClient.queries.query({
    sql: {
      query: query,
      parameters: [
        {
          name: "name",
          type: "string",
          value: `%${name}%`,
        },
        {
          name: "suite",
          type: "string",
          value: `%${suite}%`,
        },
        {
          name: "file",
          type: "string",
          value: `%${file}%`,
        },
      ],
    },
  });
  const flakyTestQueryResults = flakyTestQuery.results ?? [];

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
      });
    }
    res.push(info);
  }
  return res;
}
