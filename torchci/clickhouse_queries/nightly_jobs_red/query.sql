-- Filters with IN subqueries rather than joining workflow_run and push: those
-- joins read every push and workflow run (~12 GB of memory per call). push is
-- matched on its cheap after/dynamoKey columns, not its wide tuples.
SELECT
    DATE_TRUNC({granularity: String }, job.created_at) AS granularity_bucket,
    AVG(
        job.conclusion IN ('failure', 'timed_out', 'cancelled', 'skipped')
    ) AS red
FROM
    workflow_job job
WHERE
    job.created_at >= {startTime: DateTime64(3)}
    AND job.created_at < {stopTime: DateTime64(3)}
    AND job.name NOT LIKE '%generate-matrix%'
    AND job.name NOT LIKE '%unittests%'
    AND job.run_id IN (
        SELECT id
        FROM workflow_run
        WHERE
            id IN (
                SELECT run_id
                FROM workflow_job
                WHERE
                    created_at >= {startTime: DateTime64(3)}
                    AND created_at < {stopTime: DateTime64(3)}
            )
            AND name NOT IN ('cron', 'Bandit', 'tests')
            AND head_sha IN (
                SELECT after
                FROM push
                WHERE
                    ref = 'refs/heads/nightly'
                    AND startsWith(
                        dynamoKey, concat('pytorch/', {repo: String }, '/')
                    )
            )
    )
GROUP BY
    granularity_bucket
ORDER BY
    granularity_bucket ASC
