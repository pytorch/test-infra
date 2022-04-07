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
    failure_line as failureLine,
    failure_context as failureContext,
    failure_captures as failureCaptures,
    failure_line_number as failureLineNumber,
from
    (
        SELECT
            workflow.head_commit.id as sha,
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
            AND workflow.event != 'workflow_run' -- Filter out worflow_run-triggered jobs, which have nothing to do with the SHA
            AND ARRAY_CONTAINS(SPLIT(:shas, ','), workflow.head_commit.id)
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
            -- Classifications not yet supported
            null,
            null,
            null,
            null,
        FROM
            circleci.job job
        WHERE
            ARRAY_CONTAINS(SPLIT(:shas, ','), job.pipeline.vcs.revision)
    ) as job
