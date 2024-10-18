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
        AND has({workflowNames: Array(String) }, workflow.name)
        AND workflow.head_branch LIKE {branch: String }
        AND workflow.run_attempt = 1
        AND workflow.repository. 'full_name' = {repo: String }
        AND job.name NOT LIKE '%before-test%'
        AND job.name NOT LIKE '%determinator%'
        AND job.name NOT LIKE '%mem_leak_check%'
        AND job.name NOT LIKE '%rerun_disabled_tests%'
        AND toUnixTimestamp(job.completed_at) != 0 -- To remove jobs that are still running
),
p AS (
    SELECT
        granularity_bucket,
        tts_sec,
        -- Switch this to percent_rank once it's available on ClickHouse Cloud https://github.com/ClickHouse/ClickHouse/issues/46300
        ifNull(
            (
                rank() OVER(
                    PARTITION BY full_name
                    ORDER BY
                        tts_sec DESC
                ) - 1
            ) / nullif(count(1) OVER(PARTITION BY full_name) -1, 0),
            0
        ) AS tts_percentile,
        duration_sec,
        -- Switch this to percent_rank once it's available on ClickHouse Cloud https://github.com/ClickHouse/ClickHouse/issues/46300
        ifNull(
            (
                rank() OVER(
                    PARTITION BY full_name
                    ORDER BY
                        duration_sec DESC
                ) - 1
            ) / nullif(count(1) OVER(PARTITION BY full_name) -1, 0),
            0
        ) AS duration_percentile,
        full_name,
    FROM
        tts_duration
),
filtered_p AS (
    SELECT
        *
    FROM
        p
    WHERE
        p.tts_percentile >= (1.0 - {percentile: Float32})
        OR p.duration_percentile >= (1.0 - {percentile: Float32})
)
SELECT
    granularity_bucket,
    MAX(tts_sec) AS tts_percentile_sec,
    MAX(duration_sec) AS duration_percentile_sec,
    full_name
FROM
    filtered_p
GROUP BY
    granularity_bucket,
    full_name
ORDER BY
    full_name ASC
