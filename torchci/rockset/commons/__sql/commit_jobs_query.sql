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
    FROM
        workflow_job job
        INNER JOIN workflow_run workflow on workflow.id = job.run_id HINT(join_strategy = lookup)
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND workflow.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        AND workflow.event != 'repository_dispatch' -- Filter out repository_dispatch-triggered jobs, which have nothing to do with the SHA
        AND workflow.head_commit.id = :sha
        AND workflow.repository.full_name = :repo
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
    FROM
        circleci.job job
    WHERE
        job.pipeline.vcs.revision = :sha
        AND CONCAT(job.organization.name, '/', job.project.name) = :repo
),
-- Use a subquery for classifications to ensure we can do a lookup join, which greatly improves query performance.
classification AS (
    SELECT
        classification.job_id,
        classification.line,
        classification.captures,
        classification.line_num,
    FROM
        "GitHub-Actions".classification
        INNER JOIN job ON classification.job_id = job.id
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
    classification.line as failureLine,
    classification.line_num as failureLineNumber,
    classification.captures as failureCaptures,
from
    job
    LEFT JOIN classification ON classification.job_id = job.id
where
    job.sha = :sha
ORDER BY
    name
