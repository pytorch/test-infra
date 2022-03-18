WITH job as (
    SELECT
        job._event_time as time,
        workflow.head_commit.id as sha,
        job.name as job_name,
        workflow.name as workflow_name,
        job.id,
        workflow.id as workflow_id,
        workflow.artifacts_url as github_artifact_url,
        job.conclusion,
        job.html_url,
        CONCAT(
            'https://ossci-raw-job-status.s3.amazonaws.com/log/',
            CAST(job.id as string)
        ) as log_url,
        DATE_DIFF(
            'SECOND',
            PARSE_TIMESTAMP_ISO8601(job.started_at),
            PARSE_TIMESTAMP_ISO8601(job.completed_at)
        ) as duration_s,
        classification.line as failure_line,
        classification.context as failure_context,
        classification.captures as failure_captures,
        classification.line_num as failure_line_number,
    FROM
        workflow_job job
        JOIN workflow_run workflow on workflow.id = job.run_id
        LEFT JOIN "GitHub-Actions".classification ON classification.job_id = job.id
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        and workflow.head_commit.id = :sha
    UNION
        -- Handle CircleCI
        -- IMPORTANT: this needs to have the same order as the query above
    SELECT
        job._event_time as time,
        job.pipeline.vcs.revision as sha,
        -- Swap workflow and job name for consistency with GHA naming style.
        job.workflow.name as job_name,
        job.job.name as workflow_name,
        job.job.number as id,
        null as workflow_id,
        null as github_artifact_id,
        case
            WHEN job.job.status = 'failed' then 'failure'
            WHEN job.job.status = 'canceled' then 'cancelled'
            else job.job.status
        END as conclusion,
        -- cirleci doesn't provide a url, piece one together out of the info we have
        CONCAT(
            'https://app.circleci.com/pipelines/github/pytorch/pytorch/',
            CAST(job.pipeline.number as string),
            '/workflows/',
            job.workflow.id,
            '/jobs/',
            CAST(job.job.number AS string)
        ) as html_url,
        -- logs aren't downloaded currently, just reuse html_url
        html_url as log_url,
        DATE_DIFF(
            'SECOND',
            PARSE_TIMESTAMP_ISO8601(job.job.started_at),
            PARSE_TIMESTAMP_ISO8601(job.job.stopped_at)
        ) as duration_s,
        -- Classifications not yet supported
        null,
        null,
        null,
        null,
    FROM
        circleci.job job
    WHERE
        job.pipeline.vcs.revision = :sha
)
SELECT
    sha,
    workflow_name as workflowName,
    job_name as jobName,
    CONCAT(workflow_name, ' / ', job_name) as name,
    CAST(id as string) as id,
    CAST(workflow_id as string) as workflowId,
    github_artifact_url as githubArtifactUrl,
    CASE
        when conclusion is NULL then 'pending'
        else conclusion
    END as conclusion,
    html_url as htmlUrl,
    log_url as logUrl,
    duration_s as durationS,
    failure_line as failureLine,
    failure_line_number as failureLineNumber,
    failure_context as failureContext,
    failure_captures as failureCaptures,
from
    job
where
    job.sha = :sha
ORDER BY
    name
