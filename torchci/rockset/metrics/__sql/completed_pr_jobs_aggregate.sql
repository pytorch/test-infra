-- This query is used to generate the CI Wait Time KPI for the pytorch/pytorch repo
-- It's not the full kpi. Rather, this performs some early data processing and aggregation, which
-- is then used by a python script to generate the final KPI, which gets uploaded back to rockset 
-- to be generally queryable
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
            AND j._event_time > (
                CURRENT_DATETIME() - DAYS(:from_days_ago)
            )
            AND r._event_time > (
                CURRENT_DATETIME() - DAYS(:from_days_ago)
            )
            AND j._event_time < (CURRENT_DATETIME() - DAYS(:to_days_ago))
            AND r._event_time < (CURRENT_DATETIME() - DAYS(:to_days_ago))
            AND LENGTH(r.pull_requests) = 1
            AND r.head_branch NOT IN ('master', 'main', 'nightly', 'viable/strict')
            AND r.pull_requests[1].head.repo.name = 'pytorch'
            AND r.name IN ('pull', 'trunk', 'Lint') 
            -- Ensure we don't pull in random PRs we don't care about
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
    -- Now filter the list to just closed PRs
    merged_pr_shas AS (
        SELECT  
            DISTINCT s.pr_number,
            s.url,
            s.sha
        FROM
            pr_shas s
            INNER JOIN commons.pull_request pr on s.pr_number = pr.number
        WHERE
            pr.closed_at IS NOT NULL 
            -- Ensure the PR was actaully merged
            AND 'Merged' IN (
                SELECT  
                    name
                FROM
                    UNNEST(pr.labels)
            )
    ),
    -- Get all the workflows and partially aggregate the jobs run against each commit (based on the job's conclusion)
    commit_job_durations AS (
        SELECT  
            s.pr_number,
            r.name AS workflow_name,
            s.sha,
            j.conclusion AS conclusion,
            j.conclusion = 'cancelled' AS was_cancelled, -- For convenience
            j.run_attempt, -- the attemp # this job was run on
            r.run_attempt AS total_attempts,
            r.id AS workflow_run_id,
            min(r.run_started_at) AS start_time,
            max(PARSE_TIMESTAMP_ISO8601(j.completed_at)) AS end_time,
            DATE_DIFF(
                'MINUTE',
                min(j._event_time),
                max(PARSE_TIMESTAMP_ISO8601(j.completed_at))
            ) AS duration_mins,
            r.html_url AS workflow_url, -- for debugging
            s.url, -- for debugging 
        FROM
            commons.workflow_job j
            INNER JOIN merged_pr_shas s on j.head_sha = s.sha
            INNER JOIN commons.workflow_run r on j.run_id = r.id
        WHERE
            1 = 1
            AND (
                r.name IN ('pull', 'trunk', 'Lint')
                OR r.name like 'linux-binary%'
                OR r.name like 'windows-binary%'
            ) 
            -- skipped jobs are irrelevant to us
            AND j.conclusion NOT IN ('skipped')
        GROUP BY
            pr_number,
            workflow_name,
            url,
            sha,
            run_attempt,
            total_attempts,
            conclusion,
            was_cancelled,
            workflow_run_id,
            workflow_url
    )
SELECT
    *
FROM
    commit_job_durations
ORDER BY pr_number DESC