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
    commons.workflow_job job
    JOIN commons.workflow_run workflow on workflow.id = job.run_id
WHERE
    job.name != 'ciflow_should_run'
    AND job.name != 'generate-test-matrix'
    AND workflow.repository.full_name = 'pytorch/pytorch'
    AND job.created_at >= {startTime: DateTime64(3)}
    AND job.created_at < {stopTime: DateTime64(3)}
    AND job.conclusion = 'success'
    AND workflow.head_branch LIKE :branch
    AND workflow.run_attempt = 1
GROUP BY
    name
ORDER BY
    count * tts_sec DESC
