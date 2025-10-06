-- vLLM trunk health history
-- Returns individual main branch builds with timestamps for hourly visualization

SELECT
    tupleElement(build, 'number') AS build_number,
    tupleElement(build, 'started_at') AS build_started_at,
    tupleElement(build, 'state') AS build_state,
    if(
        lowerUTF8(tupleElement(build, 'state')) IN ('passed', 'finished', 'success'),
        1,
        0
    ) AS is_green
FROM vllm.vllm_buildkite_builds
WHERE
    tupleElement(pipeline, 'repository') = {repo: String }
    AND tupleElement(pipeline, 'name') = {pipelineName: String }
    AND tupleElement(build, 'branch') = 'main'
    AND tupleElement(build, 'started_at') IS NOT NULL
    AND tupleElement(build, 'started_at') >= {startTime: DateTime64(3) }
    AND tupleElement(build, 'started_at') < {stopTime: DateTime64(3) }
ORDER BY build_started_at ASC
