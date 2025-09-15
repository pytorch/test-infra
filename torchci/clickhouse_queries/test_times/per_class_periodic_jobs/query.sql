-- same as test_time_per_file query except for the first select
WITH good_periodic_sha AS (
    SELECT
        w.head_sha AS sha
    FROM
        default .workflow_run w
    WHERE
        w.name = 'periodic'
        AND w.head_branch = 'main'
        AND w.repository. 'full_name' = 'pytorch/pytorch'
        and w.conclusion = 'success'
        and w.run_attempt = 1
    ORDER BY
        w.head_commit. 'timestamp' DESC
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
),

class_duration_per_job AS (
    SELECT
        test_run.invoking_file AS file,
        test_run.classname AS classname,
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
        test_run.classname,
        base_name,
        test_config,
        job.run_id
)

SELECT
    REPLACE(file, '.', '/') AS file,
    classname,
    base_name,
    test_config,
    AVG(time) AS time
FROM
    class_duration_per_job
GROUP BY
    file,
    classname,
    base_name,
    test_config
ORDER BY
    base_name,
    test_config,
    file,
    classname
