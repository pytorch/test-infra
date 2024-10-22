-- This query is used by pytorch .github/scripts/fetch_latest_green_commit.py script to upgrade
-- viable/strict commit. The latest green commit is the latest commit without any failures that
-- block viable/strict upgrade.  ATM, these failures are: lint, pull, and trunk
WITH job AS (
    SELECT
        job.run_attempt as _run_attempt,
        workflow.head_sha AS sha,
        job.name AS job_name,
        workflow.name AS workflow_name,
        job.id as id,
        workflow.id AS workflow_id,
        workflow.artifacts_url AS github_artifact_url,
        job.conclusion as conclusion,
        job.html_url as html_url,
        CONCAT(
            'https://ossci-raw-job-status.s3.amazonaws.com/log/',
            job.id
        ) AS log_url,
        DATE_DIFF(
            'SECOND',
            job.started_at,
            job.completed_at
        ) AS duration_s,
        IF(job.torchci_classification.'line' = '', [], [job.torchci_classification.'line']) AS failure_line,
        job.torchci_classification.'context' AS failure_context,
        job.torchci_classification.'captures' AS failure_captures,
        job.torchci_classification.'line_num' AS failure_line_number
    FROM
        default.workflow_job job final
        INNER JOIN default.workflow_run workflow final ON workflow.id = job.run_id
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND workflow.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        AND workflow.event != 'repository_dispatch' -- Filter out repository_dispatch-triggered jobs, which have nothing to do with the SHA
        and job.id in (select id from materialized_views.workflow_job_by_head_sha where head_sha in {shas: Array(String)})
        and workflow.id in (select id from materialized_views.workflow_run_by_head_sha where head_sha in {shas: Array(String)})
),
latest_jobs AS (
    SELECT
        sha,
        MAX(_run_attempt) AS run_attempt,
        workflow_name,
        job_name,
        argMax(id, _run_attempt) AS id,
        workflow_id,
        argMax(github_artifact_url, _run_attempt) AS github_artifact_url,
        argMax(conclusion, _run_attempt) AS conclusion,
        argMax(html_url, _run_attempt) AS html_url,
        argMax(log_url, _run_attempt) AS log_url,
        argMax(duration_s, _run_attempt) AS duration_s,
        argMax(failure_line, _run_attempt) AS failure_line,
        argMax(failure_line_number, _run_attempt) AS failure_line_number,
        argMax(failure_context, _run_attempt) AS failure_context,
        argMax(failure_captures, _run_attempt) AS failure_captures
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
    id,
    workflow_id AS workflowId,
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
    failure_captures AS failureCaptures
FROM
    latest_jobs
ORDER BY
    name
