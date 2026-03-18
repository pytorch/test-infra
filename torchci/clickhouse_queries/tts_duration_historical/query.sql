-- This query powers https://hud.pytorch.org/tts
SELECT
    DATE_TRUNC({granularity: String }, job.created_at) AS granularity_bucket,
    AVG(
        DATE_DIFF('second', job.workflow_created_at, job.completed_at)
    ) AS tts_avg_sec,
    AVG(
        DATE_DIFF('second', job.started_at, job.completed_at)
    ) AS duration_avg_sec,
    CONCAT(job.workflow_name, ' / ', job.name) AS full_name
FROM
    default .workflow_job job
WHERE
    job.created_at >= {startTime: DateTime64(3) }
    AND job.created_at < {stopTime: DateTime64(3) }
    AND not has({ignoredWorkflows: Array(String) }, job.workflow_name)
    AND job.repository_full_name = {repo: String }
    AND job.name NOT LIKE '%before-test%'
    AND job.name NOT LIKE '%determinator%'
    AND job.name NOT LIKE '%mem_leak_check%'
    AND job.name NOT LIKE '%rerun_disabled_tests%'
    AND toUnixTimestamp(job.completed_at) != 0 -- To remove jobs that are still running
GROUP BY
    granularity_bucket,
    full_name
ORDER BY
    full_name ASC
