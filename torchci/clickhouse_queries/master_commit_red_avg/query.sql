--- This query is used to show the average of trunk red commits on HUD metrics page
--- during a period of time
with pushes as (
  SELECT
    push.head_commit.'id' AS sha
  FROM
    default.push
  WHERE
    push.ref IN ('refs/heads/master', 'refs/heads/main')
    AND push.repository.'owner'.'name' = 'pytorch'
    AND push.repository.'name' = 'pytorch'
    AND push.head_commit.'timestamp' >= {startTime : DateTime64(3)}
    AND push.head_commit.'timestamp' < {stopTime : DateTime64(3)}
),
-- Fetch job names marked as unstable via open GitHub issues
unstable_issue_names AS (
  SELECT
    replaceRegexpOne(issue.title, '^UNSTABLE\\s+', '') AS unstable_name
  FROM
    default.issues AS issue FINAL
  WHERE
    arrayExists(x -> x.'name' = 'unstable', issue.labels)
    AND issue.state = 'open'
    AND issue.title LIKE 'UNSTABLE%'
),
all_runs as (
  SELECT
    workflow_run.id AS id,
    workflow_run.name AS name
  FROM
    default.workflow_run as workflow_run FINAL
    JOIN pushes as push ON workflow_run.head_sha = push.sha
  WHERE
    -- Limit it to workflows which block viable/strict upgrades
    lower(workflow_run.name) in {workflowNames:Array(String)}
    AND workflow_run.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
    AND workflow_run.event != 'repository_dispatch' -- Filter out repository_dispatch-triggered jobs
    AND NOT (workflow_run.event = 'workflow_dispatch' AND workflow_run.head_branch LIKE 'trunk/%') -- Filter out restart jobs
    and workflow_run.id in (
        select id from materialized_views.workflow_run_by_head_sha
        where head_sha in (select sha from pushes)
    )
),
all_jobs AS (
  SELECT
    job.conclusion_kg AS conclusion,
    job.head_sha AS sha,
    ROW_NUMBER() OVER(
      PARTITION BY job.name,
      job.head_sha
      ORDER BY
        job.run_attempt DESC
    ) AS row_num
  FROM
    default.workflow_job as job FINAL
    join all_runs as run ON run.id = workflow_job.run_id
  WHERE
    job.name != 'ciflow_should_run'
    AND job.name != 'generate-test-matrix'
    AND job.name NOT LIKE '%rerun_disabled_tests%'
    AND job.name NOT LIKE '%mem_leak_check%'
    AND job.name NOT LIKE '%unstable%'
    -- Exclude jobs marked unstable via open GitHub issues
    AND CONCAT(run.name, ' / ', job.name) NOT IN (SELECT unstable_name FROM unstable_issue_names)
    AND CONCAT(run.name, ' / ', replaceRegexpOne(job.name, ' \\(([^,]*),.*\\)$', ' (\\1)')) NOT IN (SELECT unstable_name FROM unstable_issue_names)
    and job.id in (
        select id from materialized_views.workflow_job_by_head_sha
        where head_sha in (select sha from pushes)
    )
),
all_reds AS (
  SELECT
    CAST(SUM(conclusion IN ('failure', 'time_out', 'cancelled')) > 0 AS Int8) AS any_red,
    CAST(SUM(conclusion IN ('failure', 'time_out', 'cancelled') AND row_num = 1) > 0 AS Int8) AS _broken_trunk_red
  FROM
    all_jobs
  GROUP BY
    sha
  HAVING
    COUNT(sha) > 10 -- Filter out jobs that didn't run anything.
    AND countIf(conclusion = '') = 0 -- Filter out commits that still have pending jobs.
)
SELECT
  AVG(_broken_trunk_red) as broken_trunk_red,
  AVG(any_red) - AVG(_broken_trunk_red) AS flaky_red
FROM
  all_reds
