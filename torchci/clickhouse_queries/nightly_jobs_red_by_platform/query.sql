WITH all_failed_jobs AS (
    SELECT
        COUNT(*) AS COUNT,
        workflow.path
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
        AND push.repository.'name' = {repo: String }
        AND job.created_at >= {startTime: DateTime64(3)}
        AND job.created_at < {stopTime: DateTime64(3)}
        AND job.conclusion IN ('failure', 'timed_out', 'cancelled')
    GROUP BY
        workflow.path
)

SELECT
    SUM(COUNT) AS Count,
    'Wheel' AS Platform
FROM
    all_failed_jobs
WHERE workflow.path LIKE '%wheel%'
UNION ALL
SELECT
    SUM(COUNT) AS Count,
    'Libtorch' AS Platform
FROM
    all_failed_jobs
WHERE workflow.path LIKE '%libtorch%'
