-- vLLM per-job reliability metrics
-- Computes success rate for each individual job in the CI pipeline
-- Shows which jobs are most/least reliable

WITH jobs AS (
    SELECT
        tupleElement(pipeline, 'repository') AS repository,
        tupleElement(pipeline, 'name') AS pipeline_name,
        toUInt32(tupleElement(build, 'number')) AS build_number,
        tupleElement(job, 'name') AS job_name,
        tupleElement(job, 'state') AS job_state,
        tupleElement(job, 'soft_failed') AS soft_failed,
        tupleElement(job, 'finished_at') AS job_finished_at
    FROM vllm.vllm_buildkite_jobs
    WHERE
        tupleElement(pipeline, 'repository') = {repo: String }
        AND tupleElement(pipeline, 'name') = {pipelineName: String }
        AND tupleElement(job, 'finished_at') IS NOT NULL
        AND tupleElement(job, 'finished_at') >= {startTime: DateTime64(3) }
        AND tupleElement(job, 'finished_at') < {stopTime: DateTime64(3) }
),

job_stats AS (
    SELECT
        job_name,
        -- Count clean successes: passed jobs only
        countIf(
            lowerUTF8(job_state) IN ('passed', 'finished', 'success')
        ) AS passed_count,
        -- Count soft failures: failed but soft_failed=true (flaky tests)
        countIf(
            lowerUTF8(job_state) = 'failed' AND soft_failed = true
        ) AS soft_failed_count,
        -- Count hard failures: failed jobs with soft_failed=false
        countIf(
            lowerUTF8(job_state) = 'failed' AND soft_failed = false
        ) AS failed_count,
        countIf(lowerUTF8(job_state) IN ('canceled', 'cancelled'))
            AS canceled_count,
        passed_count + soft_failed_count + failed_count + canceled_count AS total_count,
        passed_count + soft_failed_count + failed_count AS non_canceled_count,
        -- Success rate = (clean passes + soft failures) / (all non-canceled)
        if(
            non_canceled_count > 0,
            round((passed_count + soft_failed_count) / non_canceled_count, 4),
            NULL
        ) AS success_rate
    FROM jobs
    GROUP BY job_name
    HAVING non_canceled_count >= {minRuns: UInt32}
)

SELECT
    job_name,
    passed_count,
    soft_failed_count,
    failed_count,
    canceled_count,
    total_count,
    non_canceled_count,
    success_rate
FROM job_stats
ORDER BY
    success_rate ASC,
    non_canceled_count DESC
