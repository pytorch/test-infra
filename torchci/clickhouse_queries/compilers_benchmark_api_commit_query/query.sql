SELECT DISTINCT
    replaceOne(head_branch, 'refs/heads/', '') AS branch,
    head_sha AS commit,
    workflow_id,
    toDate(fromUnixTimestamp(timestamp), 'UTC') AS date
FROM benchmark.oss_ci_benchmark_torchinductor
PREWHERE
    timestamp >= toUnixTimestamp({startTime: DateTime64(3)})
    AND timestamp < toUnixTimestamp({stopTime:  DateTime64(3)})
WHERE
    -- optional branches
    (
        has(
            {branches: Array(String)},
            replaceOne(head_branch, 'refs/heads/', '')
        )
        OR empty({branches: Array(String)})
    )
    -- optional suites
    AND (
        has({suites: Array(String)}, suite)
        OR empty({suites: Array(String)})
    )
    -- optional dtype
    AND (
        benchmark_dtype = {dtype: String}
        OR empty({dtype: String})
    )
    -- optional mode
    AND (
        benchmark_mode = {mode: String}
        OR empty({mode: String})
    )
    -- optional device
    AND (
        device = {device: String}
        OR empty({device: String})
    )
    -- optional arch (array param); if empty array, skip filter
    AND (
        multiSearchAnyCaseInsensitive(arch, {arch: Array(String)})
        OR empty({arch: Array(String)})
    )
ORDER BY timestamp
SETTINGS session_timezone = 'UTC';
