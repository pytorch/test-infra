-- vLLM job retry statistics
-- Shows which jobs are retried most often

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
GROUP BY job_name
HAVING total_runs >= {minRuns: UInt32}
ORDER BY retry_rate DESC, retried_count DESC
LIMIT 10
