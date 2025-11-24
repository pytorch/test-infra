-- vLLM failed jobs for a specific build
-- Returns all jobs that hard-failed (soft failures excluded) for a given build number
-- Shows job details: name, state, duration, timestamps, etc.

SELECT
    tupleElement(job, 'name') AS job_name,
    tupleElement(job, 'state') AS job_state,
    tupleElement(job, 'soft_failed') AS soft_failed,
    tupleElement(job, 'started_at') AS job_started_at,
    tupleElement(job, 'finished_at') AS job_finished_at,
    tupleElement(job, 'web_url') AS job_url,
    tupleElement(job, 'exit_status') AS exit_status,
    -- Calculate duration in hours
    dateDiff(
        'second',
        tupleElement(job, 'started_at'),
        tupleElement(job, 'finished_at')
    ) / 3600.0 AS duration_hours,
    toUInt32(tupleElement(build, 'number')) AS build_number,
    tupleElement(build, 'web_url') AS build_url
FROM vllm.vllm_buildkite_jobs
WHERE
    tupleElement(pipeline, 'repository') = {repo: String}
    AND tupleElement(pipeline, 'name') = {pipelineName: String}
    AND tupleElement(build, 'branch') = 'main'
    AND toUInt32(tupleElement(build, 'number')) = {buildNumber: UInt32}
    AND lowerUTF8(tupleElement(job, 'state')) = 'failed'
    AND tupleElement(job, 'soft_failed') = FALSE
ORDER BY job_name ASC

