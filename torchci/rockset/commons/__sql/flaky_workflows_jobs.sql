with repeats as (
    select
        array_agg(j.id) as ids
    from
        workflow_job j
        join workflow_run w on w.id = j.run_id
    where
        j._event_time >= PARSE_DATETIME_ISO8601(:startTime)
        and j._event_time < PARSE_DATETIME_ISO8601(:stopTime)
        and w.head_repository.full_name = :repo
        and w.head_branch = :branch
        AND w.event != 'workflow_run'
        AND w.event != 'repository_dispatch'
    group by
        j.head_sha,
        j.name,
        w.name
    having
        count(*) > :count
        and bool_or(
            j.conclusion in ('failure', 'cancelled', 'time_out')
        )
),
ids as (
    select
        ids.id
    from
        repeats,
        unnest(repeats.ids as id) as ids
)
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
    ids
    join workflow_job job on job.id = ids.id
    inner join workflow_run w on w.id = job.run_id
where
    job.conclusion in ('failure', 'cancelled', 'time_out')
