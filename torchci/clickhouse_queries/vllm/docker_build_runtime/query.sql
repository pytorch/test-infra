-- vLLM Docker Build Image Runtime Trends (main branch only)
-- Tracks runtime for the ":docker: build image" job specifically
-- This is a critical job for build speed monitoring

WITH jobs AS (
    SELECT
        tupleElement(job, 'name') AS job_name,
        tupleElement(job, 'started_at') AS job_started_at,
        tupleElement(job, 'finished_at') AS job_finished_at,
        tupleElement(job, 'state') AS job_state,
        tupleElement(build, 'number') AS build_number
    FROM vllm.vllm_buildkite_jobs
    WHERE
        tupleElement(pipeline, 'repository') = {repo: String }
        AND tupleElement(build, 'branch') = 'main'
        AND tupleElement(job, 'name') = ':docker: build image'
        AND tupleElement(job, 'started_at') IS NOT NULL
        AND tupleElement(job, 'finished_at') IS NOT NULL
        AND tupleElement(job, 'started_at') >= {startTime: DateTime64(3) }
        AND tupleElement(job, 'started_at') < {stopTime: DateTime64(3) }
        AND lowerUTF8(tupleElement(job, 'state')) IN ('passed', 'finished', 'success', 'failed')
)

SELECT
    job_started_at AS timestamp,
    build_number,
    round(dateDiff('second', job_started_at, job_finished_at) / 60.0, 2) AS runtime_minutes
FROM jobs
ORDER BY job_started_at ASC

