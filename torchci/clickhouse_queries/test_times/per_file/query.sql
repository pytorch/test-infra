WITH most_recent_strict_commits AS (
    SELECT push.head_commit.id AS sha
    FROM
        default.push
    WHERE
        push.ref = 'refs/heads/viable/strict'
        AND push.repository.full_name = 'pytorch/pytorch'
    ORDER BY
        push.head_commit.timestamp DESC
    LIMIT
        3
),

job AS (
    SELECT DISTINCT
        j.name,
        j.id,
        j.run_id
    FROM
        default.workflow_job j
    WHERE j.id IN (
        SELECT id FROM materialized_views.workflow_job_by_head_sha
        WHERE head_sha IN (SELECT sha FROM most_recent_strict_commits)
    )
),

file_duration_per_job AS (
    SELECT
        test_run.invoking_file AS file,
        SUM(time) AS time,
        REGEXP_EXTRACT(job.name, '^(.*) /', 1) AS base_name,
        REGEXP_EXTRACT(job.name, '/ test \(([\w-]*),', 1) AS test_config
    FROM
        default.test_run_summary test_run
    INNER JOIN job ON test_run.job_id = job.id
    WHERE
        /* cpp tests do not populate `file` for some reason. */
        /* Exclude them as we don't include them in our slow test infra */
        test_run.file != ''
        AND test_run.workflow_id IN (SELECT run_id FROM job)
    GROUP BY
        test_run.invoking_file,
        base_name,
        test_config,
        job.run_id
)

SELECT
    REPLACE(file, '.', '/') AS file,
    base_name,
    test_config,
    AVG(time) AS time
FROM
    file_duration_per_job
GROUP BY
    file,
    base_name,
    test_config
ORDER BY
    base_name,
    test_config,
    file
