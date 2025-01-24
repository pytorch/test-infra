SELECT
    DATE_TRUNC(
        {granularity: String },
        time
    ) AS granularity_bucket,
    AVG(
        CASE
            WHEN conclusion = 'failure' THEN 1
            WHEN conclusion = 'timed_out' THEN 1
            WHEN conclusion = 'cancelled' THEN 1
            WHEN conclusion = 'skipped' THEN 1
            ELSE 0
        END
    ) AS red
FROM
    (
        SELECT
            job.created_at AS time,
            job.conclusion AS conclusion
        FROM
            workflow_job job
        JOIN workflow_run workflow ON workflow.id = job.run_id
        JOIN push ON workflow.head_commit.'id' = push.head_commit.'id'
        WHERE
            job.name NOT LIKE '%generate-matrix%'
            AND job.name NOT LIKE '%unittests%'
            AND workflow.name NOT IN ('cron', 'Bandit', 'tests')
            AND push.ref = 'refs/heads/nightly'
            AND push.repository.'owner'.'name' = 'pytorch'
            AND push.repository.'name' = {repo: String }
            AND job.created_at >= {startTime: DateTime64(3)}
            AND job.created_at < {stopTime: DateTime64(3)}
    )
GROUP BY
    granularity_bucket
ORDER BY
    granularity_bucket ASC
