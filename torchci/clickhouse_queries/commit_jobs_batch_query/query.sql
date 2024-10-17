-- This query is used by pytorch .github/scripts/fetch_latest_green_commit.py script to upgrade
-- viable/strict commit. The latest green commit is the latest commit without any failures that
-- block viable/strict upgrade.  ATM, these failures are: lint, pull, and trunk
WITH job AS (
    SELECT
        job._event_time AS time,
        job.run_attempt,
        workflow.head_commit.id AS sha,
        job.name AS job_name,
        workflow.name AS workflow_name,
        job.id,
        workflow.id AS workflow_id,
        workflow.artifacts_url AS github_artifact_url,
        job.conclusion,
        job.html_url,
        CONCAT(
            'https://ossci-raw-job-status.s3.amazonaws.com/log/',
            CAST(job.id AS string)
        ) AS log_url,
        DATE_DIFF(
            'SECOND',
            PARSE_TIMESTAMP_ISO8601(job.started_at),
            PARSE_TIMESTAMP_ISO8601(job.completed_at)
        ) AS duration_s,
        classification.line AS failure_line,
        classification.context AS failure_context,
        classification.captures AS failure_captures,
        classification.line_num AS failure_line_number,
    FROM
        workflow_job job
        INNER JOIN workflow_run workflow ON workflow.id = job.run_id HINT(join_strategy = lookup)
        LEFT JOIN "GitHub-Actions" .classification ON classification.job_id = job.id HINT(join_strategy = lookup)
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND workflow.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        AND workflow.event != 'repository_dispatch' -- Filter out repository_dispatch-triggered jobs, which have nothing to do with the SHA
        AND ARRAY_CONTAINS(SPLIT(: shas, ','), workflow.head_commit.id)
    UNION
        -- Handle CircleCI
        -- IMPORTANT: this needs to have the same order as the query above
    SELECT
        job._event_time AS time,
        job.run_attempt,
        job.pipeline.vcs.revision AS sha,
        -- Swap workflow and job name for consistency with GHA naming style.
        job.workflow.name AS job_name,
        job.job.name AS workflow_name,
        job.job.number AS id,
        null AS workflow_id,
        null AS github_artifact_id,
        CASE
            WHEN job.job.status = 'failed' THEN 'failure'
            WHEN job.job.status = 'canceled' THEN 'cancelled'
            ELSE job.job.status
        END AS conclusion,
        -- cirleci doesn't provide a url, piece one together out of the info we have
        CONCAT(
            'https://app.circleci.com/pipelines/github/pytorch/pytorch/',
            CAST(job.pipeline.number AS string),
            '/workflows/',
            job.workflow.id,
            '/jobs/',
            CAST(job.job.number AS string)
        ) AS html_url,
        -- logs aren't downloaded currently, just reuse html_url
        html_url AS log_url,
        DATE_DIFF(
            'SECOND',
            PARSE_TIMESTAMP_ISO8601(job.job.started_at),
            PARSE_TIMESTAMP_ISO8601(job.job.stopped_at)
        ) AS duration_s,
        -- Classifications not yet supported
        null,
        null,
        null,
        null,
    FROM
        circleci.job job
    WHERE
        ARRAY_CONTAINS(SPLIT(: shas, ','), job.pipeline.vcs.revision)
),
latest_jobs AS (
    SELECT
        sha,
        MAX(run_attempt) AS run_attempt,
        workflow_name,
        job_name,
        MAX_BY(id, run_attempt) AS id,
        workflow_id,
        MAX_BY(github_artifact_url, run_attempt) AS github_artifact_url,
        MAX_BY(conclusion, run_attempt) AS conclusion,
        MAX_BY(html_url, run_attempt) AS html_url,
        MAX_BY(log_url, run_attempt) AS log_url,
        MAX_BY(duration_s, run_attempt) AS duration_s,
        MAX_BY(failure_line, run_attempt) AS failure_line,
        MAX_BY(failure_line_number, run_attempt) AS failure_line_number,
        MAX_BY(failure_context, run_attempt) AS failure_context,
        MAX_BY(failure_captures, run_attempt) AS failure_captures,
    FROM
        job
    GROUP BY
        sha,
        workflow_id,
        workflow_name,
        job_name
)
SELECT
    sha,
    run_attempt,
    workflow_name AS workflowName,
    job_name AS jobName,
    CONCAT(workflow_name, ' / ', job_name) AS name,
    CAST(id AS string) AS id,
    CAST(workflow_id AS string) AS workflowId,
    github_artifact_url AS githubArtifactUrl,
    CASE
        WHEN conclusion is NULL THEN 'pending'
        ELSE conclusion
    END AS conclusion,
    html_url AS htmlUrl,
    log_url AS logUrl,
    duration_s AS durationS,
    failure_line AS failureLine,
    failure_line_number AS failureLineNumber,
    failure_context AS failureContext,
    failure_captures AS failureCaptures,
FROM
    latest_jobs
ORDER BY
    name
