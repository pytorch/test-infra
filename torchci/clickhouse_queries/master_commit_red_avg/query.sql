--- This query is used to show the average of trunk red commits on HUD metrics page
--- during a period of time
with pushes as (
  SELECT
    push.head_commit.'id' AS sha
  FROM
    default.push FINAL
  WHERE
    push.ref IN ('refs/heads/master', 'refs/heads/main')
    AND push.repository.'owner'.'name' = 'pytorch'
    AND push.repository.'name' = {repo: String}
    AND push.head_commit.'timestamp' >= {startTime : DateTime64(3)}
    AND push.head_commit.'timestamp' < {stopTime : DateTime64(3)}
), all_jobs AS (
  SELECT
    job.conclusion AS conclusion,
    push.sha AS sha,
    ROW_NUMBER() OVER(
      PARTITION BY job.name,
      push.sha
      ORDER BY
        job.run_attempt DESC
    ) AS row_num
  FROM
    default.workflow_job job FINAL
    JOIN default.workflow_run FINAL ON workflow_run.id = workflow_job.run_id
    JOIN pushes push ON workflow_run.head_sha = push.sha
  WHERE
    job.name != 'ciflow_should_run'
    AND job.name != 'generate-test-matrix'
    AND (
      -- Limit it to workflows which block viable/strict upgrades
      lower(workflow_run.name) in {workflowNames:Array(String)}
      OR workflow_run.name like 'linux-binary%'
    )
    AND job.name NOT LIKE '%rerun_disabled_tests%'
    AND job.name NOT LIKE '%mem_leak_check%'
    AND job.name NOT LIKE '%unstable%'
    AND workflow_run.event != 'workflow_run' -- Filter out worflow_run-triggered jobs, which have nothing to do with the SHA
    and workflow_run.id in (
        select id from materialized_views.workflow_run_by_head_sha
        where head_sha in (select sha from pushes)
    )
    and job.id in (
        select id from materialized_views.workflow_job_by_head_sha
        where head_sha in (select sha from pushes)
    )
),
all_reds AS (
  SELECT
    CAST(
      SUM(
        CASE
          WHEN conclusion = 'failure' THEN 1
          WHEN conclusion = 'timed_out' THEN 1
          WHEN conclusion = 'cancelled' THEN 1
          ELSE 0
        END
      ) > 0 AS int
    ) AS any_red,
    CAST(
      SUM(
        CASE
          WHEN conclusion = 'failure' AND row_num = 1 THEN 1
          WHEN conclusion = 'timed_out' AND row_num = 1 THEN 1
          WHEN conclusion = 'cancelled' AND row_num = 1 THEN 1
          ELSE 0
        END
      ) > 0 AS int
    ) AS broken_trunk_red
  FROM
    all_jobs
  GROUP BY
    sha
  HAVING
    COUNT(sha) > 10 -- Filter out jobs that didn't run anything.
    AND SUM(
      IF(conclusion = '', 1, 0)
    ) = 0 -- Filter out commits that still have pending jobs.
),
avg_reds AS (
  SELECT
    AVG(broken_trunk_red) AS broken_trunk_red,
    AVG(any_red) AS any_red
  FROM
    all_reds
)
SELECT
  broken_trunk_red,
  any_red - broken_trunk_red AS flaky_red
FROM
  avg_reds
