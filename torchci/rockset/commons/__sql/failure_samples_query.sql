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
    torchci_classification.line as failureLine,
    torchci_classification.line_num as failureLineNumber,
    torchci_classification.captures AS failureCaptures,
from
    workflow_run w
    INNER JOIN workflow_job job ON w.id = job.run_id
where
    torchci_classification.captures = :captures
    AND job._event_time > (CURRENT_TIMESTAMP() - INTERVAL 14 day)
ORDER BY
    workflow_job._event_time DESC
