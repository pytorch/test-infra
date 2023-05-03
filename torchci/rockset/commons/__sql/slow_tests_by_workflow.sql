WITH
    shas AS (
        (
            select
                job.head_sha as sha
            from
                commons.workflow_job job
                JOIN commons.workflow_run workflow on workflow.id = job.run_id
                JOIN push on workflow.head_commit.id = push.head_commit.id
            where
                workflow.name = :workflow
                AND workflow.head_branch LIKE 'main'
            group by
                job.head_sha,
                push._event_time
            having
                BOOL_AND(
                    job.conclusion = 'success'
                    and job.conclusion is not null
                )
            order by
                push._event_time desc
            limit
                3
        )
        union
        (
            select
                job.head_sha as sha
            from
                commons.workflow_job job
                JOIN commons.workflow_run workflow on workflow.id = job.run_id
                JOIN push on workflow.head_commit.id = push.head_commit.id
            where
                workflow.name = :workflow
                AND workflow.head_branch LIKE 'main'
            group by
                job.head_sha,
                push._event_time
            having
                BOOL_AND(job.conclusion is not null)
            order by
                push._event_time desc
            limit
                1
        )
    ), workflows AS (
        SELECT
            id
        FROM
            commons.workflow_run w
            INNER JOIN shas c on w.head_sha = c.sha
        WHERE
            w.name = :workflow
    ),
    job AS (
        SELECT
            j.id,
            REGEXP_EXTRACT(j.name, '^(.*) /', 1) as base_name,
        FROM
            commons.workflow_job j
            INNER JOIN workflows w on w.id = j.run_id
    ),
    duration_per_job AS (
        SELECT
            test_run.classname,
            test_run.name,
            job.base_name,
            job.id,
            SUM(time) as time
        FROM
            commons.test_run_s3 test_run
            /* test_run is ginormous and job is small, so lookup join is essential */
            INNER JOIN job ON test_run.job_id = job.id HINT(join_strategy = lookup)
        WHERE
            /* cpp tests do not populate file for some reason. */
            /* Exclude them as we don't include them in our slow test infra */
            test_run.file IS NOT NULL
            /* do some more filtering to cut down on the test_run size */
            AND test_run.skipped IS NULL
            AND test_run.failure IS NULL
            AND test_run.error IS NULL
        GROUP BY
            test_run.classname,
            test_run.name,
            job.id,
            job.base_name
    )
SELECT
    CONCAT(name, ' (__main__.', classname, ')') as test_name,
    AVG(time) as avg_duration_sec,
    base_name,
FROM
    duration_per_job
GROUP BY
    CONCAT(name, ' (__main__.', classname, ')'),
    base_name
HAVING
    AVG(time) > 60.0
ORDER BY
    test_name
