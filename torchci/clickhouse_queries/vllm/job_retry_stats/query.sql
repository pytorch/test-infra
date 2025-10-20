-- vLLM job retry statistics
-- Shows which jobs are retried most often
-- Supports filtering by job groups: AMD, Torch Nightly, or Main

SELECT
    tupleElement(job, 'name') AS job_name,
    count(*) AS total_runs,
    countIf(tupleElement(job, 'retried') = true) AS retried_count,
    if(
        total_runs > 0,
        round(retried_count / total_runs, 4),
        null
    ) AS retry_rate
FROM vllm.vllm_buildkite_jobs
WHERE
    tupleElement(pipeline, 'repository') = {repo: String}
    AND tupleElement(pipeline, 'name') = {pipelineName: String}
    AND tupleElement(build, 'branch') = 'main'
    AND tupleElement(build, 'started_at') IS NOT null
    AND tupleElement(build, 'started_at') >= {startTime: DateTime64(3)}
    AND tupleElement(build, 'started_at') < {stopTime: DateTime64(3)}
    -- Job group filtering: AMD, Torch Nightly, or Main
    AND (
        (has({jobGroups: Array(String)}, 'amd') AND positionCaseInsensitive(tupleElement(job, 'name'), 'AMD') > 0)
        OR (has({jobGroups: Array(String)}, 'torch_nightly') AND positionCaseInsensitive(tupleElement(job, 'name'), 'Torch Nightly') > 0)
        OR (has({jobGroups: Array(String)}, 'main') 
            AND positionCaseInsensitive(tupleElement(job, 'name'), 'AMD') = 0 
            AND positionCaseInsensitive(tupleElement(job, 'name'), 'Torch Nightly') = 0)
    )
GROUP BY job_name
HAVING total_runs >= {minRuns: UInt32}
ORDER BY retry_rate DESC, retried_count DESC
LIMIT 10
