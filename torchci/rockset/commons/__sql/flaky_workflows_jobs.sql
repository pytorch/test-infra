-- Find workflows that succeeded once they were retried
with repeats as (
    select
        j.run_id,
        j.name
    from
        workflow_job j
    where
        j._event_time > CURRENT_TIMESTAMP() - DAYS(7)
        and j.run_attempt > 1
        and j.conclusion = 'success'
) -- When a first time contributor submits a PR, their workflow starts at "attempt 2" so we look for workflows that were repeated above and actually have a first attempt
select
    job.head_sha as sha,
    CONCAT(w.name, ' / ', job.name) as jobName,
    job.id,
    job.conclusion,
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
    w.repository.full_name as repo,
    job.torchci_classification.line as failureLine,
    job.torchci_classification.captures as failureCaptures,
    job.torchci_classification.line_num as failureLineNumber,
from
    workflow_job job
    inner join workflow_run w on w.id = job.run_id
    inner join repeats on repeats.run_id = job.run_id and repeats.name = job.name
where
    w.repository.full_name = :repo
    and job._event_time >= PARSE_DATETIME_ISO8601(:startTime)
    and job._event_time < PARSE_DATETIME_ISO8601(:stopTime)
    and job.run_attempt = 1
    and w.head_branch = :branch
    and (
        job.conclusion like 'fail%'
        or job.conclusion = 'cancelled'
        or job.conclusion = 'time_out'
    )