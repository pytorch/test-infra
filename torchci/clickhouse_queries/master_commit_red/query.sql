--- This query is used to show the histogram of trunk red commits on HUD metrics page
--- during a period of time
-- Split up the query into multiple CTEs to make it faster.
with commits as (
  select
    push.head_commit.'timestamp' as time,
    push.head_commit.'id' as sha
  from
    push final
  where
    push.ref in ('refs/heads/master', 'refs/heads/main')
    and push.repository.'owner'.'name' = 'pytorch'
    and push.repository.'name' = 'pytorch'
    and push.head_commit.'timestamp' >= {startTime: DateTime64(3)}
    and push.head_commit.'timestamp' < {stopTime: DateTime64(3)}
),
all_runs as (
  select
    workflow_run.id as id,
    workflow_run.head_commit.'id' as sha,
    workflow_run.name as name,
    commit.time as time
  from
    workflow_run final
    join commits commit on workflow_run.head_commit.'id' = commit.sha
  where
    (
      -- Limit it to workflows which block viable/strict upgrades
      workflow_run.name in ('Lint', 'pull', 'trunk')
      OR workflow_run.name like 'linux-binary%'
    )
    AND workflow_run.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
    and workflow_run.id in (select id from materialized_views.workflow_run_by_head_sha where head_sha in (select sha from commits))
),
all_jobs AS (
  SELECT
    workflow_run.time AS time,
    CASE
      WHEN job.conclusion = 'failure' THEN 'red'
      WHEN job.conclusion = 'timed_out' THEN 'red'
      WHEN job.conclusion = 'cancelled' THEN 'red'
      WHEN job.conclusion = '' THEN 'pending'
      ELSE 'green'
    END as conclusion,
    workflow_run.sha AS sha
  FROM
    default.workflow_job job final join all_runs workflow_run on workflow_run.id = workflow_job.run_id
  WHERE
    job.name != 'ciflow_should_run'
    AND job.name != 'generate-test-matrix'
    AND job.name NOT LIKE '%rerun_disabled_tests%'
    AND job.name NOT LIKE '%unstable%'
    and job.id in (select id from materialized_views.workflow_job_by_head_sha where head_sha in (select sha from commits))
),
commit_overall_conclusion AS (
  SELECT
    time,
    sha,
    CASE
      WHEN countIf(conclusion = 'red') > 0 THEN 'red'
      WHEN countIf(conclusion = 'pending') > 0 THEN 'pending'
      ELSE 'green'
    END AS overall_conclusion
  FROM
    all_jobs
  GROUP BY
    time,
    sha
  HAVING
    COUNT(*) > 10 -- Filter out jobs that didn't run anything.
  ORDER BY
    time DESC
)
SELECT
  toDate(
    date_trunc('hour', time),
    {timezone: String}
  ) AS granularity_bucket,
  countIf(overall_conclusion = 'red') AS red,
  countIf(overall_conclusion = 'pending') AS pending,
  countIf(overall_conclusion = 'green') AS green,
  COUNT(*) as total
FROM
  commit_overall_conclusion
GROUP BY
  granularity_bucket
ORDER BY
  granularity_bucket ASC
