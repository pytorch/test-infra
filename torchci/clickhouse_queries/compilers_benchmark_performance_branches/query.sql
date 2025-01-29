-- This query is used to get the list of branches and commits used by different
-- OSS CI benchmark experiments. This powers HUD TorchInductor benchmarks dashboards
SELECT
    DISTINCT w.head_branch AS head_branch,
    w.head_sha,
    w.id,
    p.filename,
    toStartOfDay(fromUnixTimestamp64Milli(p.timestamp)) AS event_time
FROM
    benchmark.inductor_torch_dynamo_perf_stats p
    LEFT JOIN default .workflow_run w ON p.workflow_id = w.id
WHERE
    p.timestamp >= toUnixTimestamp64Milli({startTime: DateTime64(3) })
    AND p.timestamp < toUnixTimestamp64Milli({stopTime: DateTime64(3) })
    AND p.filename LIKE CONCAT(
        '%_',
        {dtypes: String },
        '_',
        {mode: String },
        '_',
        {device: String },
        '_performance%'
    )
ORDER BY
    w.head_branch,
    event_time DESC
