SELECT
    replaceOne(head_branch, 'refs/heads/', '') AS branch,
    head_sha AS commit,
    workflow_id,
    toStartOfHour(min(fromUnixTimestamp(timestamp))) AS date
FROM benchmark.oss_ci_benchmark_torchinductor
PREWHERE
    timestamp >= toUnixTimestamp({startTime: DateTime64(3)})
    AND timestamp < toUnixTimestamp({stopTime:  DateTime64(3)})
WHERE
    (
        has(
            {branches: Array(String)},
            replaceOne(head_branch, 'refs/heads/', '')
        )
        OR empty({branches: Array(String)})
    )
    AND (
        has({suites: Array(String)}, suite)
        OR empty({suites: Array(String)})
    )
    AND (benchmark_dtype = {dtype: String} OR empty({dtype: String}))
    AND (benchmark_mode = {mode: String} OR empty({mode: String}))
    AND (device = {device: String} OR empty({device: String}))
    AND (
        multiSearchAnyCaseInsensitive(arch, {arch: Array(String)})
        OR empty({arch: Array(String)})
    )
GROUP BY
    branch, commit, workflow_id
ORDER BY
    branch, date
SETTINGS session_timezone = 'UTC';
