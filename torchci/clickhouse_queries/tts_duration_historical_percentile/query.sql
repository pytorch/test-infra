-- This query powers https://hud.pytorch.org/tts
WITH tts_duration AS (
    SELECT
        DATE_TRUNC({granularity: String }, job.created_at) AS granularity_bucket,
        DATE_DIFF('second', workflow.created_at, job.completed_at) AS tts_sec,
        DATE_DIFF('second', job.started_at, job.completed_at) AS duration_sec,
        CONCAT(workflow.name, ' / ', job.name) AS full_name
    FROM
        default .workflow_job job FINAL
        JOIN default .workflow_run workflow FINAL ON workflow.id = job.run_id
    WHERE
        job.created_at >= {startTime: DateTime64(3) }
        AND job.created_at < {stopTime: DateTime64(3) }
        AND not has({ignoredWorkflows: Array(String) }, workflow.name)
        AND workflow.head_branch LIKE {branch: String }
        AND workflow.run_attempt = 1
        AND workflow.repository. 'full_name' = {repo: String }
        AND job.name NOT LIKE '%before-test%'
        AND job.name NOT LIKE '%determinator%'
        AND job.name NOT LIKE '%mem_leak_check%'
        AND job.name NOT LIKE '%rerun_disabled_tests%'
        AND toUnixTimestamp(job.completed_at) != 0 -- To remove jobs that are still running
)
SELECT
    granularity_bucket,
    quantile({percentile: Float32})(tts_sec) AS tts_percentile_sec,
    quantile({percentile: Float32})(duration_sec) AS duration_percentile_sec,
    full_name
FROM
    tts_duration
GROUP BY
    granularity_bucket,
    full_name
ORDER BY
    full_name ASC
