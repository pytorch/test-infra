-- See nightly_jobs_red for why push is matched with IN subqueries. The join
-- is only against the few nightly workflow runs in the window.
SELECT
    COUNT(*) AS COUNT,
    workflow.name AS name
FROM
    workflow_job job
JOIN (
    SELECT DISTINCT
        id,
        name
    FROM workflow_run
    WHERE
        id IN (
            SELECT run_id
            FROM workflow_job
            WHERE
                created_at >= {startTime: DateTime64(3)}
                AND created_at < {stopTime: DateTime64(3)}
        )
        AND name NOT IN ('cron', 'Bandit', 'tests', 'Lint')
        AND head_sha IN (
            SELECT after
            FROM push
            WHERE
                ref = 'refs/heads/nightly'
                AND splitByChar('/', dynamoKey)[1] = 'pytorch'
                AND splitByChar('/', dynamoKey)[2] IN (
                    'pytorch', 'vision', 'audio'
                )
        )
) workflow ON workflow.id = job.run_id
WHERE
    job.created_at >= {startTime: DateTime64(3)}
    AND job.created_at < {stopTime: DateTime64(3)}
    AND job.name NOT LIKE '%generate-matrix%'
    AND job.name NOT LIKE '%unittests%'
    AND job.conclusion IN ('failure', 'timed_out', 'cancelled')
GROUP BY
    workflow.name
