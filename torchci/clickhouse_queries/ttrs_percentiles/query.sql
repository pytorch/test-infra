-- This query is used to compute the TTRS KPI for the pytorch/pytorch repo.
--
-- Results are displayed on HUD in two views:
--   The kpi view, where percentile_to_get should be left at zero in order to get the default percentiles
--   The metrics view, where the percentile_to_get and one_bucket should be set in order to get just the desired percentile
--
-- This query has two special params:
--     percentile_to_get: Custom percentile to get
--     one_bucket: When set to false, buckets data into weekly percentiles. When true, it treats
--                 entire time range AS one big bucket and returns percnetiles accordingly

WITH
-- Get all PRs that were merged into master, and get all the SHAs for commits from that PR which CI jobs ran against
-- We need the shas because some jobs (like trunk) don't have a PR they explicitly ran against, but they _were_ run against
-- a commit from a PR
pr_shas AS (
  SELECT
    r.pull_requests[1].'number' AS pr_number,
    CONCAT(
      'https://github.com/pytorch/pytorch/pull/',
      r.pull_requests[1].'number'
    ) AS url,
    j.head_sha AS sha
  FROM
    default.workflow_job j final
    INNER JOIN default.workflow_run r final ON j.run_id = r.id
  WHERE
    1 = 1
    and j.id in (
      select id from
      materialized_views.workflow_job_by_started_at
      where started_at > {startTime: DateTime64(3)}
      and started_at < {stopTime: DateTime64(3)}
    )
    and r.id in (
      select id from
      materialized_views.workflow_run_by_run_started_at
      where run_started_at > {startTime: DateTime64(3)}
      and run_started_at < {stopTime: DateTime64(3)}
    )
    AND LENGTH(r.pull_requests) = 1
    AND r.pull_requests[1].'head'.'repo'.'name' = {repo: String}
    AND r.name IN ('pull', 'trunk', 'Lint') -- Ensure we don't pull in random PRs we don't care about
    AND r.head_branch NOT IN (
      'master', 'main', 'nightly', 'viable/strict'
    ) -- Only measure TTRS against PRs
    AND (
      r.pull_requests[1].'base'.'ref' = 'master'
      OR r.pull_requests[1].'base'.'ref' = 'main'
      OR r.pull_requests[1].'base'.'ref' like 'gh/%/base'
    )
  GROUP BY
    pr_number,
    url,
    sha
),
-- Now filter the list to just closed PRs.
-- Open PRs can be noisy experiments which were never meant to be merged.
merged_pr_shas AS (
  SELECT
    DISTINCT pr.number as pr_number,
    s.url as url,
    s.sha
  FROM
    default.pull_request as pr final array
    join pr.labels as label
    join pr_shas s on pr_shas.pr_number = pr.number
  WHERE
    pr.closed_at != '' -- Ensure the PR was actaully merged
    AND label.name = 'Merged'
),
-- Get all the workflows run against the PR and find the steps & stats we care about
commit_job_durations AS (
  SELECT
    s.pr_number as pr_number,
    j.steps as steps,
    r.name AS workflow_name,
    j.name AS job_name,
    r.html_url AS workflow_url,
    -- for debugging
    s.sha as sha,
    j.conclusion AS conclusion,
    j.conclusion = 'cancelled' AS was_cancelled,
    -- For convenience
    j.run_attempt as run_attempt,
    -- the attempt number this job was run on
    r.run_attempt AS total_attempts,
    r.id AS workflow_run_id,
    s.url as url -- for debugging
  FROM
     default.workflow_job j final
     JOIN merged_pr_shas s ON j.head_sha = s.sha
     JOIN default.workflow_run r final ON j.run_id = r.id
  WHERE
    r.name = {workflow: String} -- Stick to pull workflows to reduce noise. Trendlines are the same within other workflows
    and j.id in (
      select id from materialized_views.workflow_job_by_head_sha mv
      where mv.head_sha in (select sha from merged_pr_shas)
    )
    AND j.conclusion = 'failure' -- we just care about failed jobs
    AND j.run_attempt = 1 -- only look at the first run attempt since reruns will either 1) succeed, so are irrelevant or 2) repro the failure, biasing our data
    and j.name NOT LIKE 'lintrunner%'
    and j.name NOT LIKE '%unstable%' -- The PR doesn't wait for unstable jobs, so they should be excluded when computing TTRS
  ),
  commit_job_durations_steps as (
      SELECT
    j.pr_number,
    js.'name' AS step_name,
    js.'conclusion' AS step_conclusion,
    js.'completed_at' AS failure_time,
    js.'started_at' AS start_time,
    j.workflow_name,
    j.job_name,
    j.workflow_url,
    j.sha,
    j.conclusion,
    j.conclusion = 'cancelled' AS was_cancelled,
    j.run_attempt,
    j.total_attempts,
    j.workflow_run_id,
    j.url -- for debugging
  FROM
   commit_job_durations j
    array JOIN j.steps as js
  WHERE
     js.'conclusion' = 'failure'
    and js.'name' LIKE 'Test%' -- Only consider test steps
),
-- Refine our measurements to only collect the first red signal per workflow
-- Gets the earliest TTRS across each workflow within the same commit
workflow_failure AS (
  SELECT DISTINCT
    d.pr_number,
    d.sha,
    d.workflow_run_id,
    FIRST_VALUE(d.step_name) OVER(
      PARTITION BY d.pr_number, d.sha, d.workflow_run_id
      ORDER BY d.failure_time
    ) as step_name,
    FIRST_VALUE(d.workflow_name) OVER(
      PARTITION BY d.pr_number, d.sha, d.workflow_run_id
      ORDER BY d.failure_time
    ) as workflow_name,
    date_diff(
      'second',
      FIRST_VALUE(d.start_time) OVER(
        PARTITION BY d.pr_number, d.sha, d.workflow_run_id
        ORDER BY d.failure_time
      ),
      FIRST_VALUE(d.failure_time) OVER(
        PARTITION BY d.pr_number, d.sha, d.workflow_run_id
        ORDER BY d.failure_time
      )
    ) / 60.0 as ttrs_mins,
    FIRST_VALUE(d.workflow_url) OVER(
      PARTITION BY d.pr_number, d.sha, d.workflow_run_id
      ORDER BY d.failure_time
    ) as workflow_url,
    FIRST_VALUE(d.start_time) OVER(
      PARTITION BY d.pr_number, d.sha, d.workflow_run_id
      ORDER BY d.failure_time
    ) as start_time,
    FIRST_VALUE(d.failure_time) OVER(
      PARTITION BY d.pr_number, d.sha, d.workflow_run_id
      ORDER BY d.failure_time
    ) as failure_time
  FROM
    commit_job_durations_steps d
),
workflow_failure_buckets AS (
  SELECT
    -- When :one_bucket is set to true, we want the ttrs percentile over all the data
    DATE_TRUNC(
      'week',
      IF(
        {one_bucket: Bool},
        now(),
        start_time
      )
    ) AS bucket,
    *
  FROM
    workflow_failure
),
percentiles AS (
  SELECT
    w.bucket,
    quantileExact({percentile_to_get: Float32})(w.ttrs_mins) as custom,
    quantileExact(.25)(w.ttrs_mins) as p25,
    quantileExact(.5)(w.ttrs_mins) as p50,
    quantileExact(.75)(w.ttrs_mins) as p75,
    quantileExact(.9)(w.ttrs_mins) as p90
  FROM
    workflow_failure_buckets w
  group by w.bucket
),

kpi_results AS (
  SELECT
    formatDateTime(d.bucket, '%Y-%m-%d') AS bucket,
    -- rolling average
    (
      ROUND(AVG(custom) OVER(
        ORDER BY
          -- Average over this many + 1 buckets (two weeks)
          bucket ROWS 0 PRECEDING
      ))
    ) AS custom,
    (
      ROUND(AVG(p25) OVER(
        ORDER BY
          bucket ROWS 0 PRECEDING
      ))
    ) AS p25,
    (
      ROUND(AVG(p50) OVER(
        ORDER BY
          bucket ROWS 0 PRECEDING
      ))
    ) AS p50,
    (
      ROUND(AVG(p75) OVER(
        ORDER BY
          bucket ROWS 0 PRECEDING
      ))
    ) AS p75,
    (
      ROUND(AVG(p90) OVER(
        ORDER BY
          bucket ROWS 0 PRECEDING
      ))
    ) AS p90
  FROM
    percentiles d
  WHERE
    {one_bucket: Bool}
    OR (
      d.bucket < CURRENT_TIMESTAMP() - INTERVAL 1 WEEK
    ) -- discard the latest bucket, which will have noisy, partial data
)
SELECT
  *
FROM
  kpi_results
ORDER BY
  bucket DESC
