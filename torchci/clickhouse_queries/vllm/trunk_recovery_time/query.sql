-- vLLM trunk recovery time
-- Tracks how long it takes to recover when main breaks
-- Pattern: Last Success → Failed (break) → ... → Failed → Success (recovery)
-- Measures time from initial break to recovery
-- UPDATED: Fixed to only track TRUE state transitions (not consecutive failures)
-- Supports filtering by job groups: AMD, Torch Nightly, or Main

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
),

main_builds AS (
    SELECT
        build_number,
        any(build_started_at) AS build_started_at,
        any(build_state) AS build_state,
        countIf(lowerUTF8(job_state) = 'failed' AND soft_failed = FALSE)
            AS hard_failure_count,
        -- Build is successful if no hard failures among filtered jobs
        -- Build is failed if there are any hard failures among filtered jobs
        -- Build is canceled/unknown (-1) if it's canceled
        if(
            lowerUTF8(build_state) IN ('canceled', 'cancelled'),
            -1,
            if(hard_failure_count > 0, 0, 1)
        ) AS is_success
    FROM build_jobs
    GROUP BY build_number
),

-- Track ONLY actual state transitions (not all builds)
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

-- Identify TRUE state transitions only (skip consecutive same-state builds)
state_transitions AS (
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
        is_success != prev_is_success  -- Only actual transitions
        AND prev_is_success IS NOT NULL
),

-- For each recovery, find the immediately preceding break
events_with_prev AS (
    SELECT
        build_number,
        build_started_at,
        event_type,
        lagInFrame(build_started_at)
            OVER (
                ORDER BY build_started_at
            )
            AS prev_event_time,
        lagInFrame(event_type)
            OVER (
                ORDER BY build_started_at
            )
            AS prev_event_type
    FROM state_transitions
),

-- Filter to only complete recoveries within the time window
recovery_pairs AS (
    SELECT
        prev_event_time AS break_time,
        build_started_at AS recovery_time,
        dateDiff('minute', prev_event_time, build_started_at)
        / 60.0 AS recovery_hours
    FROM events_with_prev
    WHERE
        event_type = 'recovery'
        AND prev_event_type = 'break'
        AND prev_event_time IS NOT NULL
)

-- Only return recovery cycles where BOTH break and recovery are in the time window
SELECT
    break_time,
    recovery_time,
    recovery_hours
FROM recovery_pairs
WHERE
    break_time >= {startTime: DateTime64(3)}
    AND recovery_time < {stopTime: DateTime64(3)}
ORDER BY break_time ASC
