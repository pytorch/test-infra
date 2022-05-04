with default_branch_commit as (
    SELECT
        commit.timestamp,
        commit.sha,
        CAST(commit.pr_num as int) as pr_num
    from
        commit
    where
        commit.ref = :branch
        AND commit.repository.owner.name = :owner
        AND commit.repository.name = :repo
    ORDER BY
        commit.timestamp DESC
    LIMIT
        50 OFFSET :page * 50
),
original_pr as (
    SELECT
        p.number as number,
        p.head.sha as pr_head_sha,
        default_branch_commit.sha as default_branch_commit_sha,
        default_branch_commit.timestamp as default_branch_commit_time,
    FROM
        pull_request p
        INNER JOIN default_branch_commit on p.number = default_branch_commit.pr_num
)
SELECT
    pr_head_sha,
    default_branch_commit_sha,
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
            workflow.head_commit.id as pr_head_sha,
            original_pr.default_branch_commit_sha as default_branch_commit_sha,
            job.name as job_name,
            workflow.name as workflow_name,
            job.id,
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
            INNER JOIN original_pr on workflow.head_commit.id = original_pr.pr_head_sha
            LEFT JOIN "GitHub-Actions".classification ON classification.job_id = job.id
        WHERE
            job.name != 'ciflow_should_run'
            AND job.name != 'generate-test-matrix'
            AND workflow.event != 'workflow_run' -- Filter out worflow_run-triggered jobs, which have nothing to do with the SHA
        UNION
            -- Handle CircleCI
            -- IMPORTANT: this needs to have the same order as the query above
        SELECT
            job.pipeline.vcs.revision,
            original_pr.default_branch_commit_sha,
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
            INNER JOIN original_pr on job.pipeline.vcs.revision = original_pr.pr_head_sha
    ) as job
