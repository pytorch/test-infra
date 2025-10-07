-- vLLM trunk recovery time
-- Tracks how long it takes to recover when main breaks
-- Shows time between when main went red and when it went green again

WITH main_builds AS (
    SELECT
        tupleElement(build, 'number') AS build_number,
        tupleElement(build, 'started_at') AS build_started_at,
        tupleElement(build, 'state') AS build_state,
        if(
            lowerUTF8(build_state) IN ('passed', 'finished', 'success'),
            1,
            if(lowerUTF8(build_state) = 'failed', 0, -1)
        ) AS is_success
    FROM vllm.vllm_buildkite_builds
    WHERE
        tupleElement(pipeline, 'repository') = {repo: String }
        AND tupleElement(pipeline, 'name') = {pipelineName: String }
        AND tupleElement(build, 'branch') = 'main'
        AND tupleElement(build, 'started_at') IS NOT NULL
        AND tupleElement(build, 'started_at') >= {startTime: DateTime64(3) }
        AND tupleElement(build, 'started_at') < {stopTime: DateTime64(3) }
),

-- Track state changes
build_with_prev AS (
    SELECT
        build_number,
        build_started_at,
        is_success,
        lagInFrame(is_success)
            OVER (
                ORDER BY build_started_at
            )
            AS prev_is_success,
        lagInFrame(build_started_at)
            OVER (
                ORDER BY build_started_at
            )
            AS prev_build_time
    FROM main_builds
    WHERE is_success IN (0, 1)
),

-- Find recovery events (failed -> success transitions)
recovery_events AS (
    SELECT
        prev_build_time AS break_time,
        build_started_at AS recovery_time,
        dateDiff('minute', prev_build_time, build_started_at)
        / 60.0 AS recovery_hours
    FROM build_with_prev
    WHERE
        is_success = 1
        AND prev_is_success = 0
        AND prev_build_time IS NOT NULL
)

SELECT
    break_time,
    recovery_time,
    recovery_hours
FROM recovery_events
ORDER BY break_time ASC
