WITH most_recent_strict_commits AS (
    SELECT
        push.head_commit.id as sha,
    FROM
        commons.push
    WHERE
        push.ref = 'refs/heads/viable/strict'
        AND push.repository.full_name = 'pytorch/pytorch'
    ORDER BY
        push._event_time DESC
    LIMIT
        3
), workflow AS (
    SELECT
        id
    FROM
        commons.workflow_run w
        INNER JOIN most_recent_strict_commits c on w.head_sha = c.sha
),
job AS (
    SELECT
        j.name,
        j.id
    FROM
        commons.workflow_job j
        INNER JOIN workflow w on w.id = j.run_id
),
file_duration_per_job AS (
    SELECT
        test_run.invoking_file as file,
        job.name,
        SUM(time) as time,
        job.id
    FROM
        commons.test_run_summary test_run
        /* `test_run` is ginormous and `job` is small, so lookup join is essential */
        INNER JOIN job ON test_run.job_id = job.id HINT(join_strategy = lookup)
    WHERE
        /* cpp tests do not populate `file` for some reason. */
        /* Exclude them as we don't include them in our slow test infra */
        test_run.file IS NOT NULL
    GROUP BY
        test_run.invoking_file,
        job.name,
        job.id
)
SELECT
    REPLACE(file, '.', '/') AS file,
    REGEXP_EXTRACT(name, '^(.*) /', 1) as base_name,
    REGEXP_EXTRACT(name, '/ test \((\w*),', 1) as test_config,
    AVG(time) as time
FROM
    file_duration_per_job
GROUP BY
    file,
    name
ORDER BY
    base_name,
    test_config,
    file

