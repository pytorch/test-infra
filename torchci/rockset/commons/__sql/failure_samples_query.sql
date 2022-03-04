SELECT
    job._event_time as time,
    w.name as workflowName,
    job.name as jobName,
    CONCAT(w.name, ' / ', job.name) as name,
    w.head_sha as sha,
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
FROM 
    "GitHub-Actions".classification c 
    JOIN commons.workflow_job job on job.id = c.job_id
    JOIN commons.workflow_run w HINT(access_path=column_scan) on w.id = job.run_id
WHERE
    w.head_branch LIKE :branch
    AND w.repository.full_name = :repo
    AND c._event_time > (CURRENT_TIMESTAMP() - INTERVAL 14 day)
    AND c.captures = :captures
ORDER BY
    c._event_time DESC
