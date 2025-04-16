-- File location is misleading, this is actually just any failed test, not
-- necessarily flaky.
WITH failed_test_runs AS (
    SELECT
        t.job_id
    FROM default.failed_test_runs AS t
    WHERE
        t.name = {name: String}
        AND t.classname = {suite: String}
        AND t.file = {file: String}
),

failed_jobs AS (
    SELECT
        j.head_sha
    FROM default.workflow_job AS j
    WHERE
        j.id IN (SELECT t.job_id FROM failed_test_runs t)
        and j.name like {jobFilter: String}
        and j.created_at >= {startTime: DateTime64(3)}
        and j.created_at <= {stopTime: DateTime64(3)}
        and j.name not like '%rerun_disabled_tests%'
),

pushes as (
    select
        distinct
        p.head_commit.'timestamp' as time,
        p.head_commit.'id' as sha
    from
        default.push p
    where p.head_commit.'id' in (select head_sha from failed_jobs)
    order by p.head_commit.'timestamp'
)

SELECT
    date_trunc({granularity: String}, time) AS date,
    count(*) as count,
    array_agg(10)(sha) as shas
FROM pushes
group by date
limit 500
