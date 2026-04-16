SELECT
    COUNT(*) AS COUNT,
    workflow.name AS name
FROM
    workflow_job job
JOIN workflow_run workflow ON workflow.id = job.run_id
JOIN push ON workflow.head_commit.'id' = push.head_commit.'id'
WHERE
    job.name NOT LIKE '%generate-matrix%'
    AND job.name NOT LIKE '%unittests%'
    AND workflow.name NOT IN ('cron', 'Bandit', 'tests', 'Lint')
    AND push.ref = 'refs/heads/nightly'
    AND push.repository.'owner'.'name' = 'pytorch'
    AND push.repository.'name' IN ('pytorch', 'vision', 'audio')
    AND job.created_at >= {startTime: DateTime64(3)}
    AND job.created_at < {stopTime: DateTime64(3)}
    AND job.conclusion IN ('failure', 'timed_out', 'cancelled')
GROUP BY
    workflow.name
