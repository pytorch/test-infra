-- This query is used to generate the TTRS KPI for the pytorch/pytorch repo.
-- Results are displayed on HUD in two views:
--   The kpi view, where "percentile_to_get" should be left blank in order to get the three default percentages
--     When percentile_to_get is left at its default value of zero, the query returns p25, p50, p75 and p90 percentiles.
--     Otherwise, it returns only the specified percentile.
--   The metrics view, where the percentile_to_get should be set in order to get just the desired percentile


WITH
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
            INNER JOIN commons.workflow_run r on j.run_id = r.id
        WHERE
            1 = 1
            AND j._event_time > (CURRENT_DATETIME() - DAYS(:from_days_ago))
            AND r._event_time > (CURRENT_DATETIME() - DAYS(:from_days_ago))
            AND j._event_time < (CURRENT_DATETIME() - DAYS(:to_days_ago))
            AND r._event_time < (CURRENT_DATETIME() - DAYS(:to_days_ago))
            AND LENGTH(r.pull_requests) = 1
            AND r.pull_requests[1].head.repo.name = 'pytorch'
            AND r.name IN ('pull', 'trunk', 'Lint') -- Ensure we don't pull in random PRs we don't care about
            AND r.head_branch NOT IN ('master', 'main', 'nightly', 'viable/strict') -- Only measure TTRS against PRs
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
            INNER JOIN commons.pull_request pr on s.pr_number = pr.number
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
            js.name as step_name,
            js.conclusion as step_conclusion,
            PARSE_TIMESTAMP_ISO8601(js.completed_at) as failure_time,
            PARSE_TIMESTAMP_ISO8601(j.started_at) AS start_time,
            PARSE_TIMESTAMP_ISO8601(j.completed_at) AS end_time,
            r.name AS workflow_name,
            j.name as job_name,
            r.html_url AS workflow_url,
            -- for debugging
            s.sha,
            j.conclusion AS conclusion,
            j.conclusion = 'cancelled' AS was_cancelled,
            -- For convenience
            j.run_attempt,
            -- the attemp # this job was run on
            r.run_attempt AS total_attempts,
            r.id AS workflow_run_id,
            s.url -- for debugging 
        FROM
            commons.workflow_job j
            CROSS JOIN UNNEST (j.steps) js
            INNER JOIN merged_pr_shas s on j.head_sha = s.sha
            INNER JOIN commons.workflow_run r on j.run_id = r.id
        WHERE
            1 = 1
            AND (
                r.name IN ('pull', 'trunk', 'Lint')
                OR r.name like 'linux-binary%'
                OR r.name like 'windows-binary%'
            ) 
            AND j.conclusion = 'failure' -- we just care about failed jobs  
            AND js.conclusion = 'failure'
            AND j.run_attempt = 1 -- only look at the first run attempt since reruns will either 1) succeed, so are irrelevant or 2) repro the failure, biasing our data
            and j.name not like 'lintrunner%'
            and js.name like 'Test%' -- Only consider test steps
    ),
    -- Refine our measurements to only collect the first red signal per workflow
    ci_failure as (
        Select
            d.pr_number,
            MIN(d.step_name) as step_name,
            min(workflow_name) as workflow_name,
            DURATION_SECONDS(min(d.failure_time) - min(d.start_time)) / 60 as ttrs_mins,
            d.sha,
            min(workflow_url) as workflow_url,
            d.workflow_run_id,
            min(d.start_time) as start_time,
            min(d.failure_time) as failure_time,
        from
            commit_job_durations d
        group by
            pr_number,
            workflow_run_id,
            sha
    ),
    -- get the earliest TTRS across each workflow within the same commit
    workflow_failure as (
        SELECT
            f.pr_number,
            MIN(f.start_time) as start_time,
            MIN(f.failure_time) as failure_time,
            MIN(f.step_name) as step_name,
            MIN(workflow_url) as workflow_url,
            MIN(f.ttrs_mins) as ttrs_mins,
            f.sha,
            f.workflow_run_id
        FROM
            ci_failure f
        GROUP BY
            pr_number,
            sha,
            workflow_run_id
    ),
    workflow_failure_buckets as (
        SELECT
            DATE_TRUNC('week', start_time) AS bucket,
            *
        FROM
            workflow_failure
    ),
    -- Within each bucket, figure out what percentile duration and num_commits each PR falls under
    percentiles as (
        SELECT
            bucket,
            ttrs_mins,
            workflow_url,
            PERCENT_RANK() OVER(
                PARTITION BY bucket
                ORDER by
                    ttrs_mins
            ) as percentile,
            sha,
        FROM
            workflow_failure_buckets
    ),
    -- All the percentiles that we want the query to determine
    percentiles_desired AS (
        SELECT
            'p50' as percentile,
            0.50 as percentile_num,
        UNION ALL
        SELECT
            'p75',
            0.75,
        UNION ALL
        SELECT
            'p90',
            0.90,
        UNION ALL
        SELECT
            'p25',
            0.25,
        UNION ALL
        -- if percentile_to_get is specified, we get and only return that percentile
        SELECT 
            CONCAT('p', CAST(ROUND(:percentile_to_get * 100) AS STRING)),
            :percentile_to_get
        WHERE :percentile_to_get > 0
    ),
    -- Take the full list of percentiles and get just the ones we care about
    ttrs_percentile as (
        SELECT
            p.bucket,
            pd.percentile,
            MIN(p.ttrs_mins) as ttrs_mins
        FROM
            percentiles p
            CROSS JOIN percentiles_desired pd
        WHERE 1=1
            AND p.percentile >= pd.percentile_num
            AND (
              :percentile_to_get <= 0 
              OR pd.percentile_num = :percentile_to_get
  )
        GROUP BY
            p.bucket,
            pd.percentile
    ),
    kpi_results as (
        SELECT
            FORMAT_TIMESTAMP('%Y-%m-%d', d.bucket) as bucket,
            -- rolling average
            (
                AVG(ttrs_mins) OVER(
                    PARTITION BY percentile
                    ORDER BY
                        -- Average over this many + 1 buckets (two weeks)
                        bucket ROWS 1 PRECEDING
                )
            ) as ttrs_mins,
            d.percentile
        FROM
            ttrs_percentile d
        WHERE
            d.bucket < CURRENT_TIMESTAMP() - INTERVAL 1 WEEK-- discard the latest bucket, which will have noisy, partial data
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
