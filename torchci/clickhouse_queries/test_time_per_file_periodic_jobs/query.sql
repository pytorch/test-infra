-- same as test_time_per_file query except for the first select
WITH good_periodic_sha AS (
    select
        job.head_sha as sha
    from
        default.workflow_job job final
        JOIN default.workflow_run workflow final on workflow.id = job.run_id
        JOIN default.push on workflow.head_commit.'id' = push.head_commit.'id'
    where
        workflow.name = 'periodic'
        AND workflow.head_branch LIKE 'main'
        and workflow.repository.'full_name' = 'pytorch/pytorch'
    group by
        job.head_sha,
        push.head_commit.'timestamp'
    having
        groupBitAnd(
            job.conclusion = 'success'
            and job.conclusion is not null
        ) = 1
    order by
        push.head_commit.'timestamp' desc
    limit
        3
), workflow AS (
    SELECT
        id
    FROM
        default.workflow_run final
    where
        id in (
            SELECT id FROM materialized_views.workflow_run_by_head_sha w
            where head_sha in (select sha from good_periodic_sha)
        )
        and name = 'periodic'
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
        where head_sha in (select sha from good_periodic_sha)
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
