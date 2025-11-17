import { queryClickhouse } from "lib/clickhouse";
import _ from "lodash";
import type { NextApiRequest, NextApiResponse } from "next";
import zlib from "zlib";

// Query for status changes between two SHAs for given job IDs and files
const QUERY = `
with job as (
    select
        id,
        regexp_replace(
            name,
            '(\\\\([^,]+, )(?:[0-9]+, )*(?:lf\\\\.)?([^)]+\\\\))',
            '\\\\1\\\\2'
        ) AS name,
        head_sha,
        workflow_name
    from
        default .workflow_job
    where
        id in {jobIds: Array(Int64)}
),
statuses as (
    SELECT
        replaceAll(invoking_file, '.', '/') as invoking_file,
        all_test_runs.name as name,
        classname,
        multiIf(
            countIf(
                failure_count = 0
                AND error_count = 0
                AND skipped_count = 0
                AND rerun_count = 0
            ) = count(*),
            'success',
            sum(skipped_count) > 0,
            'skipped',
            countIf(
                failure_count = 0
                AND error_count = 0
            ) > 0,
            'flaky',
            'failure'
        ) AS status,
        job.name AS job_name,
        job.workflow_name AS workflow_name,
        job.head_sha AS head_sha
    FROM
        tests.all_test_runs join job on all_test_runs.job_id = job.id
    PREWHERE
        job_id IN {jobIds: Array(Int64)}
        and replaceAll(invoking_file, '.', '/') IN {files: Array(String)}
    GROUP BY
        invoking_file,
        name,
        classname,
        job.name,
        job.workflow_name,
        job.head_sha
),
pivoted AS (
    SELECT
        invoking_file,
        name,
        classname,
        job_name,
        workflow_name,
        maxIf(status, head_sha = {sha1: String}) AS prev_status,
        maxIf(status, head_sha = {sha2: String}) AS new_status
    FROM
        statuses
    GROUP BY
        invoking_file,
        name,
        classname,
        job_name,
        workflow_name
)
SELECT
    name,
    classname,
    invoking_file,
    workflow_name,
    job_name,
    prev_status,
    new_status
FROM
    pivoted
WHERE
    prev_status != new_status
order by
    job_name,
    invoking_file,
    classname,
    name
LIMIT 200
`;

function getQueryForJobIds(fuzzy: boolean, before: boolean): string {
  // Get query for job ids based on fuzzy or exact matching.  Before indicates if we
  // want jobs before the given sha (true) or after (false) when fuzzy is true.
  if (!fuzzy) {
    return `
select
    regexp_replace(
        name,
        '(\\\\([^,]+, )(?:[0-9]+, )*(?:lf\\\\.)?([^)]+\\\\))',
        '\\\\1\\\\2'
    ) AS name,
    workflow_name,
    id,
    head_sha
from
    default .workflow_job
where
    head_sha in {shas: Array(String) }
`;
  }
  return `
WITH ref AS (
    SELECT
        head_commit.timestamp AS ref_ts
    FROM
        default .workflow_run
    WHERE
        head_commit.id = {sha :String }
    LIMIT
        1
), workflow_runs AS (
    select
        distinct head_commit.timestamp AS commit_ts,
        head_commit.id AS sha
    from
        default .workflow_run
    where
        head_commit.timestamp <= (
            select
                ref_ts
            from
                ref
        )
        and head_branch = 'main'
    order by
        head_commit.timestamp DESC
    limit
        1000
)
SELECT
    workflow_name,
    regexp_replace(
        t.name,
        '(\\\\([^,]+, )(?:[0-9]+, )*(?:lf\\\\.)?([^)]+\\\\))',
        '\\\\1\\\\2'
    ) as name,
    argMax(t.id, commit_ts) AS id,
    argMax(sha, commit_ts) AS head_sha
FROM
    default .workflow_job t
    join workflow_runs on t.head_sha = workflow_runs.sha
WHERE
    concat(
        workflow_name,
        ' / ',
        regexp_replace(
            t.name,
            '(\\\\([^,]+, )(?:[0-9]+, )*(?:lf\\\\.)?([^)]+\\\\))',
            '\\\\1\\\\2'
        )
    ) IN {names :Array(String) } -- input list of names
    and t.id in (
        select
            id
        from
            materialized_views.workflow_job_by_head_sha
        where
            head_sha in (
                select
                    sha
                from
                    workflow_runs
            )
    )
GROUP BY
    workflow_name,
    regexp_replace(
        t.name,
        '(\\\\([^,]+, )(?:[0-9]+, )*(?:lf\\\\.)?([^)]+\\\\))',
        '\\\\1\\\\2'
    )
`;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Support both GET and POST methods.  POST is preferred for large lists of
  // files/jobs.
  let sha1: string;
  let sha2: string;
  let filesParam: string;
  let jobsParam: string;
  // Fuzzy = true means to match jobs before sha1 and after sha2 based on
  // timestamps if a job in the job list doesn't exist for those SHAs (ex
  // periodic.  Not every sha runs periodic, so instead we find the closest jobs
  // before (for the first sha) and after (for the second sha) to get the status
  // for that test
  let fuzzy: boolean;

  if (req.method === "POST") {
    // Read from POST body
    sha1 = req.body.sha1;
    sha2 = req.body.sha2;
    filesParam = JSON.stringify(req.body.files || []);
    jobsParam = JSON.stringify(req.body.jobs || []);
    fuzzy = req.body.fuzzy === true || req.body.fuzzy === "true";
  } else {
    // Read from query parameters (GET)
    sha1 = req.query.sha1 as string;
    sha2 = req.query.sha2 as string;
    filesParam = req.query.files as string;
    jobsParam = req.query.jobs as string;
    fuzzy = req.query.fuzzy === "true";
  }

  if (!sha1 || !sha2) {
    res.status(400).json({ error: "sha1 and sha2 are required" });
    return;
  }

  // Parse the files and jobs arrays
  const files: string[] = filesParam ? JSON.parse(filesParam) : [];
  const jobs: string[] = jobsParam ? JSON.parse(jobsParam) : [];

  const jobInfo = [];
  if (fuzzy) {
    // If it's fuzzy, we need to get the job ids before the first sha, and the
    // job ids after the second sha.  If there is nothing after the second sha,
    // get the jobs before the
    const before = await queryClickhouse(getQueryForJobIds(true, true), {
      sha: sha1,
      names: jobs,
    });
    let after = await queryClickhouse(getQueryForJobIds(true, false), {
      sha: sha2,
      names: jobs,
    });
    if (after.length === 0) {
      after = await queryClickhouse(getQueryForJobIds(true, true), {
        sha: sha2,
        names: jobs,
      });
    }
    jobInfo.push(...before.map((job: any) => ({ ...job, before: true })));
    jobInfo.push(...after.map((job: any) => ({ ...job, before: false })));
  } else {
    jobInfo.push(
      ...(await queryClickhouse(getQueryForJobIds(false, false), {
        shas: [sha1, sha2],
      }))
    );
  }

  const filteredJobs = _(jobInfo)
    .filter((job) => {
      const fullJobName = `${job.workflow_name} / ${job.name}`;
      // If jobs list is provided, filter by it; otherwise include all
      if (jobs.length > 0) {
        return jobs.includes(fullJobName);
      }
      return true;
    })
    .groupBy((j) => `${j.workflow_name} / ${j.name}`)
    .values()
    .sortBy((jobs) => `${jobs[0].workflow_name} / ${jobs[0].name}`)
    .value();

  const results = [];

  for (const jobs of filteredJobs) {
    if (results.length >= 200) {
      break;
    }
    const jobIds = jobs.map((j) => j.id);
    const dummySha1 = fuzzy
      ? jobs.find((j) => j.before)?.head_sha || sha1
      : sha1;
    const dummySha2 = fuzzy
      ? jobs.find((j) => !j.before)?.head_sha || sha2
      : sha2;

    let statusChanges = await queryClickhouse(QUERY, {
      jobIds,
      sha1: dummySha1,
      sha2: dummySha2,
      files,
    });

    // Apply file filter if specified
    if (files.length > 0) {
      statusChanges = statusChanges.filter((change: any) => {
        return files.includes(change.invoking_file);
      });
    }

    results.push(...statusChanges);
  }

  res
    .status(200)
    .setHeader("Content-Encoding", "gzip")
    .send(zlib.gzipSync(JSON.stringify(results)));
}
