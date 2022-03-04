with c as (
    SELECT
        *
    from
        "GitHub-Actions".classification c
    where
        c.captures = :captures
        AND c._event_time > (CURRENT_TIMESTAMP() - INTERVAL 14 day)
    ORDER BY
        c._event_time DESC
)
SELECT
    job._event_time as time,
    w.name as workflowName,
    job.name as jobName,
    CONCAT(w.name, ' / ', job.name) as name,
    w.head_commit.id as sha,
    job.id as id,
    CASE
        when job.conclusion is NULL then 'pending'
        else job.conclusion
    END as conclusion,
    job.html_url as htmlUrl,
    CONCAT(
        'https://ossci-raw-job-status.s3.amazonaws.com/log/',
        CAST(job.id as string)
    ) as logUrl,
    DATE_DIFF(
        'SECOND',
        PARSE_TIMESTAMP_ISO8601(job.started_at),
        PARSE_TIMESTAMP_ISO8601(job.completed_at)
    ) as durationS,
    c.line as failureLine,
    c.line_num as failureLineNumber,
    c.context as failureContext,
    c.captures AS failureCaptures,
from
    workflow_run w
    INNER JOIN (
        workflow_job job
        INNER JOIN c on job.id = c.job_id
    ) ON w.id = job.run_id
where
    c.captures = :captures
ORDER BY
    c._event_time DESC
