-- Splits each model's compile time into Dynamo, AOTAutograd, Inductor and the
-- rest. The phase timers come from torch._dynamo.utils.compile_times() and are
-- uploaded as strings in metric.extra_info['benchmark_values'], so they are not
-- in benchmark.oss_ci_benchmark_torchinductor and are parsed here instead.
WITH timers AS (
    SELECT
        workflow_id,
        job_id,
        timestamp,
        tupleElement(model, 'name') AS model_name,
        tupleElement(model, 'origins')[1] AS suite,
        replaceOne(head_branch, 'refs/heads/', '') AS branch,
        REGEXP_REPLACE(
            REGEXP_REPLACE(tupleElement(benchmark, 'extra_info')['output'], '.*/', ''),
            CONCAT('_', suite, '_', {dtype: String}, '_', {mode: String}, '_', {device: String}, '_.*'),
            ''
        ) AS backend,
        tupleElement(metric, 'name') AS metric_name,
        IF(
            empty(tupleElement(metric, 'benchmark_values')),
            toFloat64OrZero(JSONExtract(tupleElement(metric, 'extra_info')['benchmark_values'], 'Array(String)')[1]),
            toFloat64(tupleElement(metric, 'benchmark_values')[1])
        ) AS value
    FROM benchmark.oss_ci_benchmark_v3
    WHERE
        timestamp >= toUnixTimestamp({startTime: DateTime64(3)})
        AND timestamp < toUnixTimestamp({stopTime: DateTime64(3)})
        AND repo = 'pytorch/pytorch'
        AND tupleElement(benchmark, 'name') = 'TorchInductor'
        AND tupleElement(benchmark, 'mode') = {mode: String}
        AND tupleElement(benchmark, 'dtype') = {dtype: String}
        AND tupleElement(metric, 'name') IN [
            'compilation_latency',
            '_compile.compile_inner',
            'OutputGraph.call_user_compiler',
            'backward._backward_impl',
            'compile_fx_inner'
        ]
        AND tupleElement(benchmark, 'extra_info')['output'] LIKE IF(
            {arch: String} = '',
            CONCAT('%\_', {dtype: String}, '\_', {mode: String}, '\_', {device: String}, '\_performance.csv'),
            CONCAT('%\_', {dtype: String}, '\_', {mode: String}, '\_', {device: String}, '\_', {arch: String}, '\_performance.csv')
        )
        AND (has({suites: Array(String)}, suite) OR empty({suites: Array(String)}))
        AND (has({branches: Array(String)}, branch) OR empty({branches: Array(String)}))
        AND (has({compilers: Array(String)}, backend) OR empty({compilers: Array(String)}))
),
per_model AS (
    SELECT
        workflow_id,
        any(job_id) AS job_id,
        DATE_TRUNC({granularity: String}, fromUnixTimestamp(min(timestamp))) AS granularity_bucket,
        model_name,
        suite,
        backend,
        maxIf(value, metric_name = 'compilation_latency') AS total,
        maxIf(value, metric_name = '_compile.compile_inner') AS compile_inner,
        maxIf(value, metric_name = 'OutputGraph.call_user_compiler') AS backend_compile,
        maxIf(value, metric_name = 'backward._backward_impl') AS lazy_backward,
        maxIf(value, metric_name = 'compile_fx_inner') AS inductor
    FROM timers
    GROUP BY workflow_id, model_name, suite, backend
    HAVING total > 0 AND compile_inner > 0
)
-- compile_inner covers Dynamo plus the forward backend compile; the backward
-- graph is compiled lazily under backward._backward_impl. compile_fx_inner
-- (Inductor) runs inside both.
SELECT
    workflow_id,
    job_id,
    granularity_bucket,
    model_name AS model,
    suite,
    backend,
    round(total, 3) AS total,
    round(greatest(compile_inner - backend_compile, 0), 3) AS dynamo,
    round(greatest(backend_compile + lazy_backward - inductor, 0), 3) AS aot_autograd,
    round(inductor, 3) AS inductor,
    round(greatest(total - dynamo - aot_autograd - inductor, 0), 3) AS other
FROM per_model
ORDER BY workflow_id DESC, suite ASC, model_name ASC
