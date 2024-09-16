SELECT
    AVG(
        DATE_DIFF(
            'second',
            workflow.created_at,
            job.completed_at
        )
    ) as tts_sec,
    COUNT(*) as count,
    CONCAT(workflow.name, ' / ', job.name) as name
FROM
    default.workflow_job job final
    JOIN default.workflow_run workflow final on workflow.id = job.run_id
WHERE
    job.name != 'ciflow_should_run'
    AND job.name != 'generate-test-matrix'
    AND workflow.repository.'full_name' = 'pytorch/pytorch'
    AND job.created_at >= {startTime: DateTime64(3)}
    AND job.created_at < {stopTime: DateTime64(3)}
    AND job.id in (
        select id from materialized_views.workflow_job_by_created_at
        WHERE created_at >= {startTime: DateTime64(3)} and created_at < {stopTime: DateTime64(3)}
    )
    AND workflow.id in (
        select id from materialized_views.workflow_run_by_created_at
        WHERE created_at >= {startTime: DateTime64(3)} and created_at < {stopTime: DateTime64(3)}
    )
    AND job.conclusion = 'success'
    AND workflow.head_branch LIKE {branch: String}
    AND workflow.run_attempt = 1
GROUP BY
    name
ORDER BY
    count * tts_sec DESC
