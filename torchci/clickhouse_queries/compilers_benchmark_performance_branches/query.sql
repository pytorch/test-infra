-- This query is used to get the list of branches and commits used by different
-- OSS CI benchmark experiments. This powers HUD TorchInductor benchmarks dashboards
SELECT DISTINCT
    replaceOne(head_branch, 'refs/heads/', '') AS head_branch,
    head_sha,
    workflow_id AS id,
    toStartOfDay(fromUnixTimestamp(timestamp)) AS event_time
FROM
    benchmark.oss_ci_benchmark_torchinductor
WHERE
    timestamp >= toUnixTimestamp({startTime: DateTime64(3) })
    AND timestamp < toUnixTimestamp({stopTime: DateTime64(3) })
    AND (
        (
            {arch: String } = ''
            AND benchmark_extra_info['output'] LIKE CONCAT(
                '%_',
                {dtype: String },
                '_',
                {mode: String },
                '_',
                {device: String },
                '_performance%'
            )
        )
        OR (
            {arch: String } != ''
            AND benchmark_extra_info['output'] LIKE CONCAT(
                '%_',
                {dtype: String },
                '_',
                {mode: String },
                '_',
                {device: String },
                '_',
                {arch: String },
                '_performance%'
            )
        )
        OR (
            benchmark_dtype = {dtype: String }
            AND benchmark_mode = {mode: String }
            AND device = {device: String }
            AND arch = {arch: String }
        )
    )
ORDER BY
    head_branch,
    timestamp DESC
