WITH results AS (
    SELECT
        timestamp,
        benchmark.name AS name,
        benchmark.mode AS mode,
        benchmark.dtype AS dtype,
        model.name AS operator,
        model.type AS suite,
        model.backend AS backend,
        workflow_id,
        replaceOne(head_branch, 'refs/heads/', '') AS head_branch,
        metric.name AS metric_name,
        arrayAvg(metric.benchmark_values) AS metric_value
    FROM
        benchmark.oss_ci_benchmark_v3
    WHERE
        timestamp >= toUnixTimestamp({startTime: DateTime64(3) })
        AND timestamp < toUnixTimestamp({stopTime: DateTime64(3) })
        AND dependencies['triton'].repo = {repo: String}
        AND suite = {suite: String}
        AND name = {benchmark_name: String}
        AND metric_name = {metric_name: String}
        AND head_branch = {branch: String}
)

SELECT DISTINCT
    results.workflow_id,
    results.head_branch,
    results.name,
    results.operator,
    results.suite,
    results.mode,
    results.dtype,
    results.backend,
    results.metric_name,
    results.metric_value,
    DATE_TRUNC(
        {granularity: String },
        fromUnixTimestamp(results.timestamp)
    ) AS granularity_bucket
FROM
    results
ORDER BY
    granularity_bucket DESC,
    workflow_id DESC,
    backend ASC,
    operator ASC
