WITH most_recent_commits AS (
    SELECT
        push.head_commit.id as sha,
        push._event_time
    FROM
        commons.push
    WHERE
        push.ref = 'refs/heads/master'
        AND push.repository.full_name = 'pytorch/pytorch'
        and push._event_time >= PARSE_DATETIME_ISO8601(:startTime)
        and push._event_time < PARSE_DATETIME_ISO8601(:stopTime)
    ORDER BY
        push._event_time DESC
),
job AS (
    SELECT
        w.id as workflow_id,
        w.name as workflow_name,
        SUM(test_run.tests) as num_tests,
        j.head_sha as sha,
    FROM
        most_recent_commits commits
        join commons.workflow_run w on w.head_sha = commits.sha
        join commons.workflow_job j on w.id = j.run_id
        left join commons.test_run_summary test_run on j.id = test_run.job_id
    group by
        workflow_id,
        workflow_name,
        sha
    having
        BOOL_AND(
            (
                j.conclusion = 'success'
                or j.conclusion = 'skipped' -- sometimes there are jobs that get shown as skipped when but they aren't supposed to run
            )
            and j.conclusion is not null
        )
),
num_tests as (
    SELECT
        job.workflow_name,
        Avg(job.num_tests) as avg_num_tests,
        DATE_TRUNC(:granularity, commits._event_time) as push_event_time,
    FROM
        job
        join most_recent_commits commits on commits.sha = job.sha
    where
        num_tests is not null
    group by
        DATE_TRUNC(:granularity, commits._event_time),
        workflow_name
    order by
        workflow_name,
        push_event_time
)
select
    workflow_name,
    avg_num_tests,
    avg_num_tests - LAG(avg_num_tests, 1) OVER (
        PARTITION BY workflow_name
        ORDER BY
            workflow_name,
            push_event_time
    ) AS change,
    push_event_time
from
    num_tests
order by
    workflow_name,
    push_event_time
