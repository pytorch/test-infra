--- This query is used to get the LLMs benchmark results from different experiments. It
--- queries the TPS and memory bandwidth for each model / quantization combos. This powers
--- the LLMs benchmark dashboard
WITH benchmarks AS (
    SELECT
        replaceOne(o.head_branch, 'refs/heads/', '') AS head_branch,
        o.workflow_id AS workflow_id,
        o.job_id AS job_id,
        o.model.'name' AS model,
        o.model.'backend' AS backend,
        o.model.'origins' AS origins,
        o.metric.'name' AS metric,
        floor(arrayAvg(o.metric.'benchmark_values'), 2) AS actual,
        floor(toFloat64(o.metric.'target_value'), 2) AS target,
        o.benchmark.'mode' AS mode,
        o.benchmark.'dtype' AS dtype,
        IF(
            empty(o.runners),
            tupleElement(o.benchmark, 'extra_info')['device'],
            tupleElement(o.runners[1], 'name')
        ) AS device,
        IF(
            empty(o.runners),
            tupleElement(o.benchmark, 'extra_info')['arch'],
            tupleElement(o.runners[1], 'type')
        ) AS arch,
        DATE_TRUNC(
            {granularity: String },
            fromUnixTimestamp(o.timestamp)
        ) AS granularity_bucket,
        -- Repo-specific fields
        map(
            -- Used by torchao
            'use_torch_compile',
            IF(
                tupleElement(o.benchmark, 'extra_info')['compile'] = '',
                'true',
                -- Default to true
                tupleElement(o.benchmark, 'extra_info')['compile']
            ),
            -- Used by vLLM
            'request_rate',
            JSONExtractString(
                tupleElement(o.benchmark, 'extra_info')['args'],
                'request_rate'
            ),
            'tensor_parallel_size',
            JSONExtractString(
                tupleElement(o.benchmark, 'extra_info')['args'],
                'tensor_parallel_size'
            ),
            -- Used by Cachebench
            'is_dynamic',
            IF(
                tupleElement(o.benchmark, 'extra_info')['is_dynamic'] = '',
                'false',
                -- Default to false
                tupleElement(o.benchmark, 'extra_info')['is_dynamic']
            )
        ) AS extra, --  extra key for a record, used in group model logic.
         map(
            'failure_type',
            IF(
                tupleElement(o.benchmark, 'extra_info')['failure_type'] = '',
                '',
                -- Default to empty
                tupleElement(o.benchmark, 'extra_info')['failure_type']
            ),
            'device_id',
            IF(
                tupleElement(o.benchmark, 'extra_info')['instance_arn'] = '',
                '',
                -- Default to empty
                tupleElement(o.benchmark, 'extra_info')['instance_arn']
            ),
            'timestamp',
            formatDateTime(fromUnixTimestamp(o.timestamp), '%Y-%m-%dT%H:%i:%sZ')
        ) AS metadata_info --  metadata_info for a record
    FROM
        benchmark.oss_ci_benchmark_v3 o
    WHERE
        o.timestamp >= toUnixTimestamp({startTime: DateTime64(3) })
        AND o.timestamp < toUnixTimestamp({stopTime: DateTime64(3) })
        AND o.repo = {repo: String }
        AND (
            has({commits: Array(String) }, o.head_sha)
            OR empty({commits: Array(String) })
        )
        AND (
            o.benchmark.'name' in {benchmarks: Array(String) }
            OR empty({benchmarks: Array(String) })
        )
        AND (
            has({models: Array(String) }, o.model.'name')
            OR empty({models: Array(String) })
        )
        AND (
            has({backends: Array(String) }, o.model.'backend')
            OR empty({backends: Array(String) })
        )
        AND (
            o.benchmark.'mode' = {mode: String }
            OR {mode: String } = ''
        )
        AND (
            has({dtypes: Array(String) }, o.benchmark.'dtype')
            OR empty({dtypes: Array(String) })
        )
        AND (
            NOT has({excludedMetrics: Array(String) }, o.metric.'name')
            OR empty({excludedMetrics: Array(String) })
        )
        AND notEmpty(o.metric.'name')
)

SELECT DISTINCT
    workflow_id,
    job_id,
    model,
    backend,
    origins,
    metric,
    actual,
    target,
    mode,
    dtype,
    device,
    arch,
    granularity_bucket,
    extra,
    metadata_info
FROM
    benchmarks
WHERE
    (
        has({branches: Array(String) }, head_branch)
        OR empty({branches: Array(String) })
    )
    AND (
        (startsWith({device: String }, device)
        AND (
            ({device: String } LIKE '%(private)%' AND device LIKE '%(private)%')
            OR
            ({device: String } NOT LIKE '%(private)%' AND device NOT LIKE '%(private)%')
        ))
        OR {device: String } = ''
    )
    AND notEmpty(device)
    AND (
        arch LIKE concat('%', {arch: String }, '%')
        OR {arch: String } = ''
    )
ORDER BY
    granularity_bucket DESC,
    workflow_id DESC,
    backend,
    model,
    mode,
    dtype,
    device,
    metric
