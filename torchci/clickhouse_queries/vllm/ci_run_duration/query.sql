-- vLLM CI run durations (main branch only)
-- Lists per-build durations based on build.started_at and build.finished_at
-- Only tracks main branch to exclude work-in-progress PR noise

WITH b AS (
    SELECT
        tupleElement(pipeline, 'repository') AS repository,
        tupleElement(pipeline, 'name') AS pipeline_name,
        toUInt32(tupleElement(build, 'number')) AS build_number,
        tupleElement(build, 'started_at') AS build_started_at,
        tupleElement(build, 'finished_at') AS build_finished_at,
        tupleElement(build, 'state') AS build_state
    FROM vllm.vllm_buildkite_jobs
    WHERE
        tupleElement(pipeline, 'repository') = {repo: String }
        AND tupleElement(pipeline, 'name') = {pipelineName: String }
        AND tupleElement(build, 'branch') = 'main'
        AND tupleElement(build, 'started_at') IS NOT NULL
        AND tupleElement(build, 'finished_at') IS NOT NULL
        AND tupleElement(build, 'started_at') >= {startTime: DateTime64(3) }
        AND tupleElement(build, 'started_at') < {stopTime: DateTime64(3) }
)

SELECT
    pipeline_name,
    build_number,
    max(build_started_at) AS started_at,
    max(build_finished_at) AS finished_at,
    any(build_state) AS build_state,
    dateDiff('second', started_at, finished_at) AS duration_seconds,
    round(duration_seconds / 3600.0, 3) AS duration_hours
FROM b
GROUP BY pipeline_name, build_number
ORDER BY started_at ASC
