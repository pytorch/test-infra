-- same as test_time_per_file query except for the first select
WITH good_periodic_sha AS (
    SELECT job.head_sha AS sha
    FROM
        default.workflow_job job
    JOIN default.push ON job.head_sha = push.head_commit.'id'
    WHERE
        job.workflow_name = 'periodic'
        AND job.head_branch LIKE 'main'
        AND job.repository_full_name = 'pytorch/pytorch'
    GROUP BY
        job.head_sha,
        push.head_commit.'timestamp'
    HAVING
        groupBitAnd(
            job.conclusion = 'success'
            AND job.conclusion IS NOT null
        ) = 1
    ORDER BY
        push.head_commit.'timestamp' DESC
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
        WHERE head_sha IN (SELECT sha FROM good_periodic_sha)
    )
    AND j.workflow_name = 'periodic'
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
