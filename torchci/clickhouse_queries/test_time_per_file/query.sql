WITH most_recent_strict_commits AS (
    SELECT
        push.head_commit.id as sha
    FROM
        default.push final
    WHERE
        push.ref = 'refs/heads/viable/strict'
        AND push.repository.full_name = 'pytorch/pytorch'
    ORDER BY
        push.head_commit.timestamp DESC
    LIMIT
        3
), workflow AS (
    SELECT
        id
    FROM
        materialized_views.workflow_run_by_head_sha w
    where head_sha in (select sha from most_recent_strict_commits)
),
job AS (
    SELECT
        j.name,
        j.id,
        j.run_id
    FROM
        default.workflow_job j final
    where j.id in (
        select id from materialized_views.workflow_job_by_head_sha
        where head_sha in (select sha from most_recent_strict_commits)
    )
    and j.run_id in (select id from workflow)
),
file_duration_per_job AS (
    SELECT
        test_run.invoking_file as file,
        SUM(time) as time,
        REGEXP_EXTRACT(job.name, '^(.*) /', 1) as base_name,
        REGEXP_EXTRACT(job.name, '/ test \(([\w-]*),', 1) as test_config
    FROM
        default.test_run_summary test_run
        INNER JOIN job ON test_run.job_id = job.id
    WHERE
        /* cpp tests do not populate `file` for some reason. */
        /* Exclude them as we don't include them in our slow test infra */
        test_run.file != ''
        and test_run.workflow_id in (select id from workflow)
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
    AVG(time) as time
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
