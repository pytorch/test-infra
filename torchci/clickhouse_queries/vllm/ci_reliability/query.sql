-- vLLM CI reliability metrics (main branch only)
-- Computes CI success rate, failure rate over time for Buildkite builds
-- Daily breakdown of build states (passed, failed, canceled)
-- Accounts for soft failures: builds with only soft failures count as successful
-- Only tracks main branch to exclude work-in-progress PR noise

WITH build_jobs AS (
    SELECT
        tupleElement(pipeline, 'repository') AS repository,
        tupleElement(pipeline, 'name') AS pipeline_name,
        toUInt32(tupleElement(build, 'number')) AS build_number,
        tupleElement(build, 'started_at') AS build_started_at,
        tupleElement(build, 'finished_at') AS build_finished_at,
        tupleElement(build, 'state') AS build_state,
        tupleElement(job, 'state') AS job_state,
        tupleElement(job, 'soft_failed') AS soft_failed,
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
        AND tupleElement(build, 'branch') = 'main'
        AND tupleElement(build, 'started_at') IS NOT NULL
        AND tupleElement(build, 'started_at') >= {startTime: DateTime64(3) }
        AND tupleElement(build, 'started_at') < {stopTime: DateTime64(3) }
),

builds AS (
    SELECT
        repository,
        pipeline_name,
        build_number,
        any(build_started_at) AS build_started_at,
        any(build_finished_at) AS build_finished_at,
        any(build_state) AS build_state,
        any(bucket) AS bucket,
        -- Count hard failures: job.state='failed' AND soft_failed=false
        countIf(lowerUTF8(job_state) = 'failed' AND soft_failed = FALSE)
            AS hard_failures,
        -- A build is successful if it has no hard failures
        -- (even if it has soft failures)
        if(
            hard_failures = 0
            AND lowerUTF8(build_state) NOT IN ('canceled', 'cancelled'),
            1,
            0
        ) AS is_success,
        if(lowerUTF8(build_state) IN ('canceled', 'cancelled'), 1, 0)
            AS is_canceled
    FROM build_jobs
    GROUP BY
        repository,
        pipeline_name,
        build_number
),

daily_stats AS (
    SELECT
        bucket,
        sum(is_success) AS passed_count,
        count() - sum(is_success) - sum(is_canceled) AS failed_count,
        sum(is_canceled) AS canceled_count,
        count() AS total_count,
        count() - sum(is_canceled) AS non_canceled_count,
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
