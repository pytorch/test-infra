SELECT DISTINCT
    replaceOne(head_branch, 'refs/heads/', '') AS branch,
    head_sha AS commit,
    workflow_id AS id,
    timestamp,
FROM benchmark.oss_ci_benchmark_torchinductor
PREWHERE
    timestamp >= toUnixTimestamp({startTime: DateTime64(3)})
    AND timestamp <  toUnixTimestamp({stopTime:  DateTime64(3)})
WHERE
    (
        has({branches: Array(String)}, replaceOne(head_branch, 'refs/heads/', ''))
        OR empty({branches: Array(String)})
    )
    AND benchmark_dtype = {dtype: String}
    AND benchmark_mode  = {mode: String}
    AND device          = {device: String}
    AND multiSearchAnyCaseInsensitive(arch, {arch: Array(String)})
ORDER BY timestamp
SETTINGS session_timezone = 'UTC';
