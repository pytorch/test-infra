-- vLLM trunk health history
-- Returns individual main branch builds with timestamps for hourly visualization
-- Supports filtering by job groups: AMD, Torch Nightly, or Main
-- Build success is computed based on filtered jobs only

WITH build_jobs AS (
    SELECT
        toUInt32(tupleElement(build, 'number')) AS build_number,
        tupleElement(build, 'started_at') AS build_started_at,
        tupleElement(build, 'state') AS build_state,
        tupleElement(job, 'state') AS job_state,
        tupleElement(job, 'soft_failed') AS soft_failed
    FROM vllm.vllm_buildkite_jobs
    WHERE
        tupleElement(pipeline, 'repository') = {repo: String }
        AND tupleElement(pipeline, 'name') = {pipelineName: String }
        AND tupleElement(build, 'branch') = 'main'
        AND tupleElement(build, 'started_at') IS NOT NULL
        AND tupleElement(build, 'started_at') >= {startTime: DateTime64(3) }
        AND tupleElement(build, 'started_at') < {stopTime: DateTime64(3) }
        -- Job group filtering: AMD, Torch Nightly, or Main
        AND (
            (has({jobGroups: Array(String)}, 'amd') AND positionCaseInsensitive(tupleElement(job, 'name'), 'AMD') > 0)
            OR (has({jobGroups: Array(String)}, 'torch_nightly') AND positionCaseInsensitive(tupleElement(job, 'name'), 'Torch Nightly') > 0)
            OR (has({jobGroups: Array(String)}, 'main') 
                AND positionCaseInsensitive(tupleElement(job, 'name'), 'AMD') = 0 
                AND positionCaseInsensitive(tupleElement(job, 'name'), 'Torch Nightly') = 0)
        )
)

SELECT
    build_number,
    any(build_started_at) AS build_started_at,
    any(build_state) AS build_state,
    countIf(lowerUTF8(job_state) = 'failed' AND soft_failed = FALSE) AS hard_failure_count,
    -- Build is green if it has no hard failures among filtered jobs and is not canceled
    if(
        lowerUTF8(build_state) NOT IN ('canceled', 'cancelled') AND hard_failure_count = 0,
        1,
        0
    ) AS is_green
FROM build_jobs
GROUP BY build_number
ORDER BY build_started_at ASC
