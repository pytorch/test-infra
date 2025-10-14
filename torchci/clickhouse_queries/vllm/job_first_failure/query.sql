-- Find most recent failure and first break for each job

WITH most_recent_any_failure AS (
    SELECT
        tupleElement(job, 'name') AS job_name,
        argMax(toUInt32(tupleElement(build, 'number')), tupleElement(build, 'started_at')) AS recent_failed_build,
        max(tupleElement(build, 'started_at')) AS recent_failed_at
    FROM vllm.vllm_buildkite_jobs
    WHERE
        tupleElement(pipeline, 'repository') = {repo: String}
        AND tupleElement(pipeline, 'name') = {pipelineName: String}
        AND tupleElement(build, 'branch') = 'main'
        AND tupleElement(job, 'name') IN {jobNames: Array(String)}
        AND tupleElement(build, 'started_at') IS NOT NULL
        AND tupleElement(build, 'started_at') >= now() - INTERVAL {lookbackDays: UInt32} DAY
        AND tupleElement(build, 'started_at') < now()
        AND lowerUTF8(tupleElement(job, 'state')) = 'failed'
    GROUP BY job_name
),

-- Get all job runs with success/failure state
all_job_runs AS (
    SELECT
        tupleElement(job, 'name') AS job_name,
        toUInt32(tupleElement(build, 'number')) AS build_number,
        tupleElement(build, 'started_at') AS build_started_at,
        tupleElement(job, 'state') AS job_state,
        tupleElement(job, 'soft_failed') AS soft_failed,
        -- Success if passed OR soft failure
        if(
            lowerUTF8(job_state) IN ('passed', 'finished', 'success')
            OR (lowerUTF8(job_state) = 'failed' AND soft_failed = true),
            1,
            if(lowerUTF8(job_state) = 'failed' AND soft_failed = false, 0, -1)
        ) AS is_success
    FROM vllm.vllm_buildkite_jobs
    WHERE
        tupleElement(pipeline, 'repository') = {repo: String}
        AND tupleElement(pipeline, 'name') = {pipelineName: String}
        AND tupleElement(build, 'branch') = 'main'
        AND tupleElement(job, 'name') IN {jobNames: Array(String)}
        AND tupleElement(build, 'started_at') IS NOT NULL
        AND tupleElement(build, 'started_at') >= now() - INTERVAL {lookbackDays: UInt32} DAY
        AND tupleElement(build, 'started_at') < now()
        AND is_success IN (0, 1)
),

all_runs_with_prev AS (
    SELECT
        job_name,
        build_number,
        build_started_at,
        is_success,
        lagInFrame(is_success) OVER (PARTITION BY job_name ORDER BY build_started_at) AS prev_is_success
    FROM all_job_runs
),

-- Find most recent success->failure transition for each job
first_break_per_job AS (
    SELECT
        job_name,
        build_number AS first_break_build,
        build_started_at AS first_break_at,
        ROW_NUMBER() OVER (PARTITION BY job_name ORDER BY build_started_at DESC) AS rn
    FROM all_runs_with_prev
    WHERE is_success = 0 AND prev_is_success = 1
)

-- Combine recent failure and first break info (URLs constructed client-side from build numbers)
SELECT
    a.job_name AS job_name,
    a.recent_failed_build AS recent_failed_build,
    a.recent_failed_at AS recent_failed_at,
    b.first_break_build AS first_break_build,
    b.first_break_at AS first_break_at
FROM most_recent_any_failure a
LEFT JOIN first_break_per_job b ON a.job_name = b.job_name AND b.rn = 1
ORDER BY a.recent_failed_at DESC

