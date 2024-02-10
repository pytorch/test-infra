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
    ARRAY_CREATE(job.torchci_classification.line) as failureLines,
    job.torchci_classification.captures as failureCaptures,
    ARRAY_CREATE(job.torchci_classification.line_num) as failureLineNumbers,
from
    commons.job_annotation a
    join commons.workflow_job job on job.id = a.jobID
    join commons.workflow_run w on w.id = job.run_id
    and w.head_repository.full_name = a.repo and a.repo = :repo
where
    a.annotation != 'BROKEN_TRUNK'
    and w.head_branch = :branch
    and job._event_time >= PARSE_DATETIME_ISO8601(:startTime)
    and job._event_time < PARSE_DATETIME_ISO8601(:stopTime)
order by
    job._event_time
