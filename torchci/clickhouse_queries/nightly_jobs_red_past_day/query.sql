-- See nightly_jobs_red for why this filters with IN subqueries, not joins.
SELECT
    COUNT(*) AS COUNT,
    job.name AS name
FROM
    workflow_job job
WHERE
    job.completed_at >= today() - 1
    AND job.name NOT LIKE '%generate-matrix%'
    AND job.name NOT LIKE '%unittests%'
    AND job.conclusion IN ('failure', 'timed_out', 'cancelled')
    AND job.run_id IN (
        SELECT id
        FROM workflow_run
        WHERE
            id IN (
                SELECT run_id
                FROM workflow_job
                WHERE completed_at >= today() - 1
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
GROUP BY job.name
ORDER BY COUNT
