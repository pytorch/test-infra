-- vLLM CI reliability metrics
-- Computes CI success rate, failure rate over time for Buildkite builds
-- Daily breakdown of build states (passed, failed, canceled)
-- Overall success rate and job-level reliability

WITH builds AS (
    SELECT
        tupleElement(pipeline, 'repository') AS repository,
        tupleElement(pipeline, 'name') AS pipeline_name,
        toUInt32(tupleElement(build, 'number')) AS build_number,
        tupleElement(build, 'started_at') AS build_started_at,
        tupleElement(build, 'finished_at') AS build_finished_at,
        tupleElement(build, 'state') AS build_state,
        formatDateTime(
            DATE_TRUNC(
                {granularity: String },
                tupleElement(build, 'started_at')
            ),
            '%Y-%m-%d'
        ) AS bucket
    FROM vllm.vllm_buildkite_jobs
    WHERE
        tupleElement(pipeline, 'repository') = {repo: String }
        AND tupleElement(pipeline, 'name') = {pipelineName: String }
        AND tupleElement(build, 'started_at') IS NOT NULL
        AND tupleElement(build, 'started_at') >= {startTime: DateTime64(3) }
        AND tupleElement(build, 'started_at') < {stopTime: DateTime64(3) }
    GROUP BY
        repository,
        pipeline_name,
        build_number,
        build_started_at,
        build_finished_at,
        build_state,
        bucket
),

daily_stats AS (
    SELECT
        bucket,
        countIf(lowerUTF8(build_state) IN ('passed', 'finished', 'success'))
            AS passed_count,
        countIf(lowerUTF8(build_state) = 'failed') AS failed_count,
        countIf(lowerUTF8(build_state) IN ('canceled', 'cancelled'))
            AS canceled_count,
        passed_count + failed_count + canceled_count AS total_count,
        passed_count + failed_count AS non_canceled_count,
        if(
            non_canceled_count > 0,
            round(passed_count / non_canceled_count, 4),
            NULL
        ) AS success_rate
    FROM builds
    GROUP BY bucket
)

SELECT
    bucket AS granularity_bucket,
    passed_count,
    failed_count,
    canceled_count,
    total_count,
    non_canceled_count,
    success_rate
FROM daily_stats
ORDER BY granularity_bucket ASC
