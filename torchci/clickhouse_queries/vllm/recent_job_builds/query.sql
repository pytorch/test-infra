-- vLLM recent builds for a specific job
-- Returns all builds within the time range for a given job name
-- Shows build details: number, state, duration, timestamps, etc.
-- Only tracks main branch

WITH job_builds AS (
    SELECT
        toUInt32(tupleElement(build, 'number')) AS build_number,
        tupleElement(build, 'id') AS build_id,
        tupleElement(build, 'state') AS build_state,
        tupleElement(build, 'web_url') AS build_url,
        tupleElement(build, 'started_at') AS build_started_at,
        tupleElement(build, 'finished_at') AS build_finished_at,
        tupleElement(build, 'commit') AS commit,
        tupleElement(build, 'message') AS commit_message,
        tupleElement(job, 'name') AS job_name,
        tupleElement(job, 'state') AS job_state,
        tupleElement(job, 'soft_failed') AS soft_failed,
        tupleElement(job, 'started_at') AS job_started_at,
        tupleElement(job, 'finished_at') AS job_finished_at,
        tupleElement(job, 'web_url') AS job_url,
        -- Calculate duration in hours
        dateDiff(
            'second',
            tupleElement(job, 'started_at'),
            tupleElement(job, 'finished_at')
        ) / 3600.0 AS duration_hours
    FROM vllm.vllm_buildkite_jobs
    WHERE
        tupleElement(pipeline, 'repository') = {repo: String}
        AND tupleElement(pipeline, 'name') = {pipelineName: String}
        AND tupleElement(build, 'branch') = 'main'
        AND tupleElement(job, 'name') = {jobName: String}
        AND tupleElement(job, 'finished_at') IS NOT NULL
        AND tupleElement(job, 'finished_at') >= {startTime: DateTime64(3)}
        AND tupleElement(job, 'finished_at') < {stopTime: DateTime64(3)}
)

SELECT
    build_number,
    build_id,
    build_state,
    build_url,
    build_started_at,
    build_finished_at,
    commit,
    commit_message,
    job_name,
    job_state,
    soft_failed,
    job_started_at,
    job_finished_at,
    job_url,
    duration_hours
FROM job_builds
ORDER BY job_finished_at DESC

