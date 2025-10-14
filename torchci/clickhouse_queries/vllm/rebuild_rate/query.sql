-- vLLM job retry rate metrics
-- Tracks how often jobs are retried (indicates flaky tests or infrastructure issues)

WITH jobs AS (
    SELECT
        tupleElement(job, 'name') AS job_name,
        tupleElement(job, 'retried') AS was_retried,
        tupleElement(build, 'started_at') AS build_started_at,
        formatDateTime(
            DATE_TRUNC(
                {granularity: String},
                tupleElement(build, 'started_at')
            ),
            '%Y-%m-%d'
        ) AS bucket
    FROM vllm.vllm_buildkite_jobs
    WHERE
        tupleElement(pipeline, 'repository') = {repo: String}
        AND tupleElement(pipeline, 'name') = {pipelineName: String}
        AND tupleElement(build, 'branch') = 'main'
        AND tupleElement(build, 'started_at') IS NOT NULL
        AND tupleElement(build, 'started_at') >= {startTime: DateTime64(3)}
        AND tupleElement(build, 'started_at') < {stopTime: DateTime64(3)}
),

daily_stats AS (
    SELECT
        bucket,
        count() AS total_jobs,
        countIf(was_retried = TRUE) AS retried_count,
        if(
            total_jobs > 0,
            round(retried_count / total_jobs, 4),
            NULL
        ) AS retry_rate
    FROM jobs
    GROUP BY bucket
)

SELECT
    bucket AS granularity_bucket,
    total_jobs,
    retried_count,
    retry_rate
FROM daily_stats
ORDER BY granularity_bucket ASC
