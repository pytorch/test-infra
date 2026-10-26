-- See nightly_jobs_red for why push is matched with IN subqueries. The join
-- is only against the few nightly workflow runs in the window.
WITH all_failed_jobs AS (
    SELECT
        COUNT(*) AS COUNT,
        workflow.path AS path
    FROM
        workflow_job job
    JOIN (
        SELECT DISTINCT
            id,
            path
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
                    AND startsWith(
                        dynamoKey, concat('pytorch/', {repo: String }, '/')
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
        workflow.path
)

SELECT
    SUM(COUNT) AS Count,
    'Wheel' AS Platform
FROM
    all_failed_jobs
WHERE path LIKE '%wheel%'
UNION ALL
SELECT
    SUM(COUNT) AS Count,
    'Libtorch' AS Platform
FROM
    all_failed_jobs
WHERE path LIKE '%libtorch%'
