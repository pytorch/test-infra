SELECT
    workflow_id,
    job_id,
    head_sha AS commit,
    replaceOne(head_branch, 'refs/heads/', '') AS branch,
    suite,
    model_name AS model,
    metric_name AS metric,
    value,
    metric_extra_info AS extra_info,
    benchmark_extra_info['output'] AS output,
    benchmark_dtype AS dtype,
    benchmark_mode AS mode,
    device,
    arch,
    timestamp,
    DATE_TRUNC({granularity: String}, fromUnixTimestamp(timestamp))
        AS granularity_bucket
FROM benchmark.oss_ci_benchmark_torchinductor
WHERE
    head_sha IN ({commits: Array(String)})
    AND (
        has(
            {branches: Array(String)},
            replaceOne(head_branch, 'refs/heads/', '')
        )
        OR empty({branches: Array(String)})
    )
    AND (
        has({suites: Array(String) }, suite)
        OR empty({suites: Array(String) })
    )
    AND (
        has({models: Array(String)}, model_name)
        OR empty({models: Array(String) })
    )
    AND (benchmark_dtype = {dtype: String} OR empty({dtype: String}))
    AND (benchmark_mode = {mode: String} OR empty({mode: String}))
    AND (device = {device: String} OR empty({device: String}))
    AND (
        multiSearchAnyCaseInsensitive(arch, {arch: Array(String)})
        OR empty({arch: Array(String)})
    )
ORDER BY timestamp
SETTINGS session_timezone = 'UTC';
