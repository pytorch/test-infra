WITH job AS (
    SELECT
        job.head_sha as sha,
        job.name as job_name,
        workflow.name as workflow_name,
        job.id,
        job.conclusion,
        job.html_url as html_url,
        CONCAT(
            'https://ossci-raw-job-status.s3.amazonaws.com/log/',
            CAST(job.id as string)
        ) as log_url,
        DATE_DIFF(
            'SECOND',
            PARSE_TIMESTAMP_ISO8601(job.started_at),
            PARSE_TIMESTAMP_ISO8601(job.completed_at)
        ) as duration_s,
        workflow.repository.full_name as repo,
        job.torchci_classification.line,
        job.torchci_classification.captures,
        job.torchci_classification.line_num,
    FROM
        workflow_job job
        INNER JOIN workflow_run workflow on workflow.id = job.run_id
    WHERE
        job.name != 'ciflow_should_run'
        AND job.name != 'generate-test-matrix'
        AND workflow.event != 'workflow_run' -- Filter out workflow_run-triggered jobs, which have nothing to do with the SHA
        AND workflow.event != 'repository_dispatch' -- Filter out repository_dispatch-triggered jobs, which have nothing to do with the SHA
        AND ARRAY_CONTAINS(SPLIT(:shas, ','), job.head_sha)
        AND ARRAY_CONTAINS(SPLIT(:shas, ','), workflow.head_sha)
        AND workflow.repository.full_name = :repo
    UNION
        -- Handle CircleCI
        -- IMPORTANT: this needs to have the same order as the query above
    SELECT
        job.pipeline.vcs.revision as sha,
        -- Swap workflow and job name for consistency with GHA naming style.
        job.workflow.name as job_name,
        job.job.name as workflow_name,
        job.job.number as id,
        case
            WHEN job.job.status = 'failed' then 'failure'
            WHEN job.job.status = 'canceled' then 'cancelled'
            else job.job.status
        END as conclusion,
        -- cirleci doesn't provide a url, piece one together out of the info we have
        CONCAT(
            job.workflow.url,
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
        CONCAT(job.organization.name, '/', job.project.name) as repo,
        null,
        null,
        null,
    FROM
        circleci.job job
    WHERE
        ARRAY_CONTAINS(SPLIT(:shas, ','), job.pipeline.vcs.revision)
        AND CONCAT(job.organization.name, '/', job.project.name) = :repo
)
SELECT
    sha,
    CONCAT(workflow_name, ' / ', job_name) as name,
    id,
    CASE
        when conclusion is NULL then 'pending'
        else conclusion
    END as conclusion,
    html_url as htmlUrl,
    log_url as logUrl,
    duration_s as durationS,
    repo as repo,
    line as failureLine,
    line_num as failureLineNumber,
    captures as failureCaptures,
FROM
    job
