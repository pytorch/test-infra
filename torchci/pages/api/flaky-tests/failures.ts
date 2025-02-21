import { queryClickhouseSaved } from "lib/clickhouse";
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
  const flakyTestQuery = await queryClickhouseSaved("flaky_tests/ind_info", {
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
