-- vLLM Job Runtime Trends (main branch only)
-- Aggregates per-job runtime statistics by day
-- Shows count, mean, p90, and max runtime for each job per day
-- Supports filtering by job groups: AMD, Torch Nightly, or Main

WITH jobs AS (
    SELECT
        tupleElement(job, 'name') AS job_name,
        tupleElement(job, 'started_at') AS job_started_at,
        tupleElement(job, 'finished_at') AS job_finished_at,
        tupleElement(job, 'state') AS job_state,
        tupleElement(build, 'branch') AS branch
    FROM vllm.vllm_buildkite_jobs
    WHERE
        tupleElement(pipeline, 'repository') = {repo: String }
        AND tupleElement(build, 'branch') = 'main'
        AND tupleElement(job, 'started_at') IS NOT NULL
        AND tupleElement(job, 'finished_at') IS NOT NULL
        AND tupleElement(job, 'started_at') >= {startTime: DateTime64(3) }
        AND tupleElement(job, 'started_at') < {stopTime: DateTime64(3) }
        AND lowerUTF8(tupleElement(job, 'state')) IN ('passed', 'finished', 'success', 'failed')
        -- Job group filtering: AMD, Torch Nightly, or Main
        AND (
            (
                has({jobGroups: Array(String)}, 'amd')
                AND positionCaseInsensitive(tupleElement(job, 'name'), 'AMD')
                > 0
            )
            OR (
                has({jobGroups: Array(String)}, 'torch_nightly')
                AND positionCaseInsensitive(
                    tupleElement(job, 'name'), 'Torch Nightly'
                )
                > 0
            )
            OR (
                has({jobGroups: Array(String)}, 'main')
                AND positionCaseInsensitive(tupleElement(job, 'name'), 'AMD')
                = 0
                AND positionCaseInsensitive(
                    tupleElement(job, 'name'), 'Torch Nightly'
                )
                = 0
            )
        )
)

SELECT
    job_name,
    toDate(job_started_at) AS date,
    count() AS count,
    round(avg(dateDiff('second', job_started_at, job_finished_at) / 60.0), 2) AS mean_runtime_minutes,
    round(quantile(0.9)(dateDiff('second', job_started_at, job_finished_at) / 60.0), 2) AS p90_runtime_minutes,
    round(max(dateDiff('second', job_started_at, job_finished_at) / 60.0), 2) AS max_runtime_minutes
FROM jobs
GROUP BY job_name, date
ORDER BY job_name ASC, date ASC

