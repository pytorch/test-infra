-- vLLM continuous builds list (daily and nightly scheduled runs)
-- Returns recent builds that are part of scheduled CI runs
-- Filters by specific BUILDKITE_MESSAGE patterns
-- Only tracks main branch

SELECT DISTINCT
    toUInt32(tupleElement(build, 'number')) AS build_number,
    tupleElement(build, 'id') AS build_id,
    tupleElement(build, 'state') AS build_state,
    tupleElement(build, 'web_url') AS build_url,
    tupleElement(build, 'started_at') AS build_started_at,
    tupleElement(build, 'finished_at') AS build_finished_at,
    tupleElement(build, 'message') AS build_message,
    tupleElement(build, 'commit') AS commit,
    -- Determine build type
    if(
        positionCaseInsensitive(tupleElement(build, 'message'), 'Full CI run - daily') > 0,
        'Daily',
        if(
            positionCaseInsensitive(tupleElement(build, 'message'), 'Nightly run - All tests') > 0,
            'Nightly',
            'Other'
        )
    ) AS build_type,
    -- Count jobs for this build
    (
        SELECT count(*)
        FROM vllm.vllm_buildkite_jobs AS j
        WHERE
            tupleElement(j.build, 'number') = tupleElement(build, 'number')
            AND tupleElement(j.pipeline, 'repository') = {repo: String}
    ) AS total_jobs,
    -- Count failed jobs for this build
    (
        SELECT count(*)
        FROM vllm.vllm_buildkite_jobs AS j
        WHERE
            tupleElement(j.build, 'number') = tupleElement(build, 'number')
            AND tupleElement(j.pipeline, 'repository') = {repo: String}
            AND lowerUTF8(tupleElement(j.job, 'state')) = 'failed'
            AND tupleElement(j.job, 'soft_failed') = FALSE
    ) AS failed_jobs_count
FROM vllm.vllm_buildkite_builds
WHERE
    tupleElement(pipeline, 'repository') = {repo: String}
    AND tupleElement(pipeline, 'name') = {pipelineName: String}
    AND tupleElement(build, 'branch') = 'main'
    AND tupleElement(build, 'finished_at') IS NOT NULL
    AND tupleElement(build, 'finished_at') >= {startTime: DateTime64(3)}
    AND tupleElement(build, 'finished_at') < {stopTime: DateTime64(3)}
    AND (
        positionCaseInsensitive(tupleElement(build, 'message'), 'Full CI run - daily') > 0
        OR positionCaseInsensitive(tupleElement(build, 'message'), 'Nightly run - All tests') > 0
    )
ORDER BY build_finished_at DESC

