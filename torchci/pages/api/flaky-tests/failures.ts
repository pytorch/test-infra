import { queryClickhouse } from "lib/clickhouse";
import { JobData } from "lib/types";
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

async function getFlakyTestInfo(
  name: string,
  suite: string,
  file: string,
  limit: number
): Promise<JobData[]> {
  const query = `
WITH failed_test_runs as (
    SELECT
        t.name AS name,
        t.classname AS classname,
        t.file AS file,
        t.invoking_file AS invoking_file,
        t.job_id
    FROM default.failed_test_runs AS t
    WHERE
      t.name = {name: String}
      and t.classname = {suite: String}
      and t.file = {file: String}),
failed_jobs AS (
    SELECT
        j.conclusion AS conclusion,
        j.id AS id,
        j.run_id AS run_id,
        j.name AS name,
        j.html_url AS html_url,
        j.started_at AS started_at,
        tupleElement(j.torchci_classification, 'line') AS line,
        tupleElement(j.torchci_classification, 'line_num') AS line_num,
        tupleElement(j.torchci_classification, 'captures') AS captures,
        j.head_sha AS head_sha
    FROM default.workflow_job AS j
    WHERE
        j.id IN (SELECT t.job_id from failed_test_runs t)
)
SELECT DISTINCT
    t.name AS name,
    t.classname AS classname,
    t.file AS file,
    t.invoking_file AS invoking_file,
    j.conclusion AS conclusion,
    j.id AS job_id,
    j.name AS job_name,
    j.html_url AS job_url,
    j.started_at AS job_started_at,
    j.line,
    j.line_num,
    j.captures,
    w.head_branch AS head_branch,
    j.head_sha AS head_sha
FROM failed_jobs AS j
    INNER JOIN failed_test_runs AS t ON j.id = t.job_id
    INNER JOIN default.workflow_run AS w ON w.id = j.run_id
ORDER BY j.started_at DESC
limit
  {limit: Int32}
`;
  const flakyTestQuery = await queryClickhouse(query, {
    name,
    suite,
    file,
    limit,
  });

  const res = [];
  for (const test of Object.values(flakyTestQuery ?? [])) {
    const info: JobData = {
      jobName: test.job_name,
      id: test.job_id,
      htmlUrl: test.job_url,
      time: test.job_started_at,
      logUrl: `https://ossci-raw-job-status.s3.amazonaws.com/log/${test.job_id}`,
      conclusion: test.conclusion,
      failureLines: [test.line],
      failureLineNumbers: [test.line_num],
      failureCaptures: [test.captures],
      branch: test.head_branch,
      sha: test.head_sha,
    };
    res.push(info);
  }
  return res;
}
