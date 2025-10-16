SELECT
    replaceAll(head_branch, 'refs/heads/', '') AS branch,
    head_sha AS commit,
    workflow_id,
    toStartOfHour(min(fromUnixTimestamp(timestamp))) AS date
FROM benchmark.oss_ci_benchmark_metadata
PREWHERE
    timestamp >= toUnixTimestamp({startTime: DateTime64(3)})
    AND timestamp <  toUnixTimestamp({stopTime:  DateTime64(3)})   -- ← closed )
WHERE
    repo = {repo: String}
    AND (
        has({branches: Array(String)}, replaceAll(head_branch, 'refs/heads/', ''))
        OR empty({branches: Array(String)})
    )
    AND (benchmark_dtype = {dtype: String} OR empty({dtype: String}))
    AND (
        has({benchmarkNames: Array(String)}, benchmark_name)
        OR empty({benchmarkNames: Array(String)})
    )
    AND notEmpty(metric_name)
    AND notEmpty(device)
    AND (
        arch LIKE concat('%', {arch: String}, '%')
        OR {arch: String} = ''
    )
    AND (
        has({models: Array(String) }, model_name)
        OR empty({models: Array(String) })
    )
    AND (
        has({backends: Array(String) }, model_backend)
        OR empty({backends: Array(String) })
    )
    AND (
        startsWith({device: String }, device)
        OR {device: String } = ''
    )
GROUP BY
    branch, commit, workflow_id
ORDER BY
    branch, date
