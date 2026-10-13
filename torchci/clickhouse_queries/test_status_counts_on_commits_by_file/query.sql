with job as (
    select
        distinct
        id,
        regexp_replace(
            name,
            '(\\([^,]+, )(?:[0-9]+, )*(?:lf\\.)?([^)]+\\))',
            '\\1\\2'
        ) AS name,
        workflow_name,
        labels
    from
        default .workflow_job
    where
        run_id in {workflowIds: Array(Int64) }
),
statuses as (
    SELECT
        replaceAll(invoking_file, '.', '/') as invoking_file,
        all_test_runs.name as name,
        classname,
        multiIf(
            countIf(
                failure_count = 0
                AND error_count = 0
                AND skipped_count = 0
                AND rerun_count = 0
            ) = count(*),
            'success',
            sum(skipped_count) > 0,
            'skipped',
            countIf(
                failure_count = 0
                AND error_count = 0
            ) > 0,
            'flaky',
            'failure'
        ) AS status,
        sum(time) / count(distinct workflow_id, workflow_run_attempt) as time,
        job.name AS job_name,
        job.workflow_name as workflow_name,
        arrayDistinct(arrayFlatten(groupArray(job.labels))) as labels
    FROM
        tests.all_test_runs
        JOIN job ON job.id = all_test_runs.job_id
    WHERE
        job_id IN (
            SELECT
                id
            FROM
                job
        )
    GROUP BY
        invoking_file,
        name,
        classname,
        job.name,
        job.workflow_name
)
select
    invoking_file as file,
    workflow_name,
    job_name,
    round(sum(time), 2) as time,
    countIf(status = 'success') as success,
    countIf(status = 'flaky') as flaky,
    countIf(status = 'skipped') as skipped,
    countIf(status = 'failure') as failure,
    arrayDistinct(arrayFlatten(groupArray(labels))) as labels
from
    statuses
group by
    file,
    workflow_name,
    job_name
