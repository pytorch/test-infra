-- vLLM trunk recovery time
-- Tracks how long it takes to recover when main breaks
-- Pattern: Last Success → Failed (break) → ... → Failed → Success (recovery)
-- Measures time from initial break to recovery

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

-- Track state changes with previous state
build_with_prev AS (
    SELECT
        build_number,
        build_started_at,
        is_success,
        lagInFrame(is_success) OVER (ORDER BY build_started_at) AS prev_is_success,
        lagInFrame(build_started_at) OVER (ORDER BY build_started_at) AS prev_build_time
    FROM main_builds
    WHERE is_success IN (0, 1)
),

-- Find both break and recovery events, then match them
state_changes AS (
    SELECT
        build_number,
        build_started_at,
        is_success,
        prev_is_success,
        CASE
            WHEN is_success = 0 AND prev_is_success = 1 THEN 'break'
            WHEN is_success = 1 AND prev_is_success = 0 THEN 'recovery'
            ELSE NULL
        END AS event_type
    FROM build_with_prev
    WHERE
        (is_success = 0 AND prev_is_success = 1)  -- break
        OR (is_success = 1 AND prev_is_success = 0)  -- recovery
),

-- For each recovery, find the most recent break before it using window function
events_with_break AS (
    SELECT
        build_started_at,
        event_type,
        lagInFrame(build_started_at) OVER (ORDER BY build_started_at) AS prev_event_time,
        lagInFrame(event_type) OVER (ORDER BY build_started_at) AS prev_event_type
    FROM state_changes
),

-- Filter to only recoveries that follow breaks
recovery_pairs AS (
    SELECT
        prev_event_time AS break_time,
        build_started_at AS recovery_time,
        dateDiff('minute', prev_event_time, build_started_at) / 60.0 AS recovery_hours
    FROM events_with_break
    WHERE
        event_type = 'recovery'
        AND prev_event_type = 'break'
        AND prev_event_time IS NOT NULL
)

SELECT
    break_time,
    recovery_time,
    recovery_hours
FROM recovery_pairs
ORDER BY break_time ASC
