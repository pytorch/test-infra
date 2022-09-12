WITH most_recent_commits AS (
    SELECT
        push.head_commit.id AS sha,
        push._event_time
    FROM
        commons.push
    WHERE
        push.ref = 'refs/heads/master'
        AND push.repository.full_name = 'pytorch/pytorch'
        AND push._event_time >= PARSE_DATETIME_ISO8601(:startTime)
        AND push._event_time < PARSE_DATETIME_ISO8601(:stopTime)
    ORDER BY
        push._event_time DESC
),
job AS (
    SELECT
        w.id AS workflow_id,
        w.name AS workflow_name,
        SUM(test_run.tests) AS num_tests,
        j.head_sha AS sha,
    FROM
        most_recent_commits commits
        JOIN commons.workflow_run w ON w.head_sha = commits.sha
        JOIN commons.workflow_job j ON w.id = j.run_id
        LEFT JOIN commons.test_run_summary test_run ON j.id = test_run.job_id
    GROUP BY
        workflow_id,
        workflow_name,
        sha
    HAVING
        BOOL_AND(
            (
                j.conclusion = 'success'
                OR j.conclusion = 'skipped' -- sometimes there are jobs that get shown as skipped when they aren't supposed to run
            )
            AND j.conclusion IS NOT null
        )
),
num_tests AS (
    SELECT
        job.workflow_name,
        Avg(job.num_tests) AS avg_num_tests,
        DATE_TRUNC(:granularity, commits._event_time) AS push_event_time,
    FROM
        job
        JOIN most_recent_commits commits ON commits.sha = job.sha
    WHERE
        num_tests IS NOT null
    GROUP BY
        DATE_TRUNC(:granularity, commits._event_time),
        workflow_name
    ORDER BY
        workflow_name,
        push_event_time
)
SELECT
    workflow_name,
    avg_num_tests,
    avg_num_tests - LAG(avg_num_tests, 1) OVER (
        PARTITION BY workflow_name
        ORDER BY
            push_event_time
    ) AS change,
    push_event_time
FROM
    num_tests
ORDER BY
    workflow_name,
    push_event_time
