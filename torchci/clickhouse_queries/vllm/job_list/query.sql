-- vLLM job list for build exploration
-- Returns a list of all jobs in the time period with basic stats
-- Used for the job selector in the JobBuildsPanel component
-- Only tracks main branch to focus on production CI

SELECT
    tupleElement(job, 'name') AS job_name,
    COUNT(*) AS total_runs,
    countIf(lowerUTF8(tupleElement(job, 'state')) IN ('passed', 'finished', 'success')) AS passed_count,
    countIf(lowerUTF8(tupleElement(job, 'state')) = 'failed') AS failed_count,
    max(tupleElement(job, 'finished_at')) AS last_run_at
FROM vllm.vllm_buildkite_jobs
WHERE
    tupleElement(pipeline, 'repository') = {repo: String}
    AND tupleElement(pipeline, 'name') = {pipelineName: String}
    AND tupleElement(build, 'branch') = 'main'
    AND tupleElement(job, 'finished_at') IS NOT NULL
    AND tupleElement(job, 'finished_at') >= {startTime: DateTime64(3)}
    AND tupleElement(job, 'finished_at') < {stopTime: DateTime64(3)}
    -- Job group filtering: AMD, Torch Nightly, or Main
    AND (
        (
            has({jobGroups: Array(String)}, 'amd')
            AND positionCaseInsensitive(tupleElement(job, 'name'), 'AMD') > 0
        )
        OR (
            has({jobGroups: Array(String)}, 'torch_nightly')
            AND positionCaseInsensitive(tupleElement(job, 'name'), 'Torch Nightly') > 0
        )
        OR (
            has({jobGroups: Array(String)}, 'main')
            AND positionCaseInsensitive(tupleElement(job, 'name'), 'AMD') = 0
            AND positionCaseInsensitive(tupleElement(job, 'name'), 'Torch Nightly') = 0
        )
    )
GROUP BY job_name
ORDER BY last_run_at DESC, total_runs DESC

