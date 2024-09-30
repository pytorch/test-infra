with jobs as (
    select
        run_id,
        created_at,
        completed_at,
        started_at,
        name
    from default.workflow_job
    where
        id in (
            select id from materialized_views.workflow_job_by_created_at
            where created_at >= {startTime: String} and created_at < {stopTime: String}
        )
)
SELECT
    DATE_TRUNC(
        {granularity: String},
        job.created_at,
    ) AS granularity_bucket,
    AVG(DATE_DIFF(
        'second',
        workflow.created_at,
        job.completed_at
    )) as tts_avg_sec,
    AVG(DATE_DIFF(
        'second',
        job.started_at,
        job.completed_at
    )) as duration_avg_sec,
    CONCAT(workflow.name, ' / ', job.name) as full_name
FROM
    jobs job
    JOIN default.workflow_run workflow final on workflow.id = job.run_id
WHERE
    workflow.id in (select run_id from jobs)
    and workflow.name in {workflowNames: Array(String)}
	AND workflow.head_branch LIKE 'main'
    AND workflow.run_attempt = 1
GROUP BY
    granularity_bucket,
    full_name
ORDER BY
    full_name ASC
