-- This query is used to compute the TTRS KPI for the pytorch/pytorch repo.
--
-- Results are displayed on HUD in two views:
--   The kpi view, where percentile_to_get should be left at zero in order to get the default percentiles
--   The metrics view, where the percentile_to_get and one_bucket should be set in order to get just the desired percentile
--
-- This query has two special params:
--     percentile_to_get: When set, it returns only the specified percentile. Otherwise it returns
--                 p25, p50, p75 and p90 percentiles.
--     one_bucket: When set to false, buckets data into weekly percentiles. When true, it treats
--                 entire time range AS one big bucket and returns percnetiles accordingly

WITH
-- All the percentiles that we want the query to determine
percentiles_desired AS (
  SELECT 
    CONCAT('p', n.percentile) as percentile,
    n.percentile / 100.0 as percentile_num
  FROM  UNNEST(ARRAY_CREATE(25, 50, 75, 90) AS percentile) AS n
  UNION ALL
    -- if percentile_to_get is specified, we get and only return that percentile
  SELECT
    CONCAT(
      'p',
      CAST(
        ROUND(: percentile_to_get * 100) AS STRING
      )
    ),
    : percentile_to_get
  WHERE
    : percentile_to_get > 0
),
-- Get all PRs that were merged into master, and get all the SHAs for commits from that PR which CI jobs ran against
-- We need the shas because some jobs (like trunk) don't have a PR they explicitly ran against, but they _were_ run against
-- a commit from a PR
pr_shas AS (
  SELECT
    r.pull_requests[1].number AS pr_number,
    CONCAT(
      'https://github.com/pytorch/pytorch/pull/',
      r.pull_requests[1].number
    ) AS url,
    j.head_sha AS sha,
  FROM
    commons.workflow_job j
    INNER JOIN commons.workflow_run r ON j.run_id = r.id
  WHERE
    1 = 1
    AND j._event_time > PARSE_DATETIME_ISO8601(: startTime)
    AND r._event_time > PARSE_DATETIME_ISO8601(: startTime)
    AND j._event_time < PARSE_DATETIME_ISO8601(: stopTime)
    AND r._event_time < PARSE_DATETIME_ISO8601(: stopTime)
    AND LENGTH(r.pull_requests) = 1
    AND r.pull_requests[1].head.repo.name = 'pytorch'
    AND r.name IN ('pull', 'trunk', 'Lint') -- Ensure we don't pull in random PRs we don't care about
    AND r.head_branch NOT IN (
      'master', 'main', 'nightly', 'viable/strict'
    ) -- Only measure TTRS against PRs
    AND (
      r.pull_requests[1].base.ref = 'master'
      OR r.pull_requests[1].base.ref = 'main'
      OR r.pull_requests[1].base.ref like 'gh/%/base'
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
    DISTINCT s.pr_number,
    s.url,
    s.sha
  FROM
    pr_shas s
    INNER JOIN commons.pull_request pr ON s.pr_number = pr.number
  WHERE
    pr.closed_at IS NOT NULL -- Ensure the PR was actaully merged
    AND 'Merged' IN (
      SELECT
        name
      FROM
        UNNEST(pr.labels)
    )
),
-- Get all the workflows run against the PR and find the steps & stats we care about
commit_job_durations AS (
  SELECT
    s.pr_number,
    j.steps,
    js.name AS step_name,
    js.conclusion AS step_conclusion,
    PARSE_TIMESTAMP_ISO8601(js.completed_at) AS failure_time,
    PARSE_TIMESTAMP_ISO8601(js.started_at) AS start_time,
    r.name AS workflow_name,
    j.name AS job_name,
    r.html_url AS workflow_url,
    -- for debugging
    s.sha,
    j.conclusion AS conclusion,
    j.conclusion = 'cancelled' AS was_cancelled,
    -- For convenience
    j.run_attempt,
    -- the attemp number this job was run on
    r.run_attempt AS total_attempts,
    r.id AS workflow_run_id,
    s.url -- for debugging
  FROM
    commons.workflow_job j CROSS
    JOIN UNNEST (j.steps) js
    INNER JOIN merged_pr_shas s ON j.head_sha = s.sha
    INNER JOIN commons.workflow_run r ON j.run_id = r.id
  WHERE
    1 = 1
    AND r.name = 'pull' -- Stick to pull workflows to reduce noise. Trendlines are the same within other workflows
    AND j.conclusion = 'failure' -- we just care about failed jobs
    AND js.conclusion = 'failure'
    AND j.run_attempt = 1 -- only look at the first run attempt since reruns will either 1) succeed, so are irrelevant or 2) repro the failure, biasing our data
    and j.name NOT LIKE 'lintrunner%'
    and j.name NOT LIKE '%unstable%' -- The PR doesn't wait for unstable jobs, so they should be excluded when computing TTRS
    and js.name LIKE 'Test%' -- Only consider test steps
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
    DURATION_SECONDS(
      FIRST_VALUE(d.failure_time) OVER(
        PARTITION BY d.pr_number, d.sha, d.workflow_run_id
        ORDER BY d.failure_time
      ) -
      FIRST_VALUE(d.start_time) OVER(
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
    ) as failure_time,
  FROM
    commit_job_durations d
),
workflow_failure_buckets AS (
  SELECT
    -- When :one_bucket is set to true, we want the ttrs percentile over all the data
    DATE_TRUNC(
      'week',
      IF(
        : one_bucket,
        CURRENT_DATETIME(),
        start_time
      )
    ) AS bucket,
    *
  FROM
    workflow_failure
),
-- Within each bucket, figure out what percentile duration and num_commits each PR falls under
percentiles AS (
  SELECT
    bucket,
    ttrs_mins,
    workflow_url,
    PERCENT_RANK() OVER(
      PARTITION BY bucket
      ORDER by
        ttrs_mins
    ) AS percentile,
    sha,
  FROM
    workflow_failure_buckets
),
-- Take the full list of percentiles and get just the ones we care about
ttrs_percentile AS (
  SELECT
    p.bucket,
    pd.percentile,
    MIN(p.ttrs_mins) AS ttrs_mins
  FROM
    percentiles p CROSS
    JOIN percentiles_desired pd
  WHERE
    1 = 1
    AND p.percentile >= pd.percentile_num
    AND (
      : percentile_to_get <= 0
      OR pd.percentile_num = : percentile_to_get
    )
  GROUP BY
    p.bucket,
    pd.percentile
),
kpi_results AS (
  SELECT
    FORMAT_TIMESTAMP('%Y-%m-%d', d.bucket) AS bucket,
    -- rolling average
    (
      AVG(ttrs_mins) OVER(
        PARTITION BY percentile
        ORDER BY
          -- Average over this many + 1 buckets (two weeks)
          bucket ROWS 1 PRECEDING
      )
    ) AS ttrs_mins,
    d.percentile
  FROM
    ttrs_percentile d
  WHERE
    : one_bucket
    OR (
      d.bucket < CURRENT_TIMESTAMP() - INTERVAL 1 WEEK
    ) -- discard the latest bucket, which will have noisy, partial data
  ORDER BY
    bucket ASC,
    ttrs_mins
)
SELECT
  *
FROM
  kpi_results
ORDER BY
  bucket DESC,
  ttrs_mins DESC