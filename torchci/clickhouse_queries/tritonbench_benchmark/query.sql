WITH results AS (
    SELECT
        timestamp,
        benchmark.name AS name,
        benchmark.mode AS mode,
        benchmark.dtype AS dtype,
        model.name AS operator,
        model.type AS suite,
        model.backend AS backend,
        dependencies['pytorch'].repo as pytorch_repo,
        dependencies['pytorch'].sha as pytorch_commit_sha,
        dependencies['triton'].repo as triton_repo,
        dependencies['triton'].sha as triton_commit_sha,
        dependencies['tritonbench'].repo as tritonbench_repo,
        dependencies['tritonbench'].sha as tritonbench_commit_sha,
        tupleElement(runners[1], 'gpu_info') AS device,
        tupleElement(runners[1], 'extra_info')['cuda_version'] AS cuda_version,
        workflow_id,
        replaceOne(head_branch, 'refs/heads/', '') AS head_branch,
        tupleElement(metric, 'extra_info')['input_shape'] AS input_shape,
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
        AND ({metric_name: String} = '*' OR metric_name = {metric_name: String})
        AND head_branch = {branch: String}
)

SELECT DISTINCT
    results.workflow_id,
    results.head_branch,
    results.pytorch_repo,
    results.pytorch_commit_sha,
    results.triton_repo,
    results.triton_commit_sha,
    results.tritonbench_repo,
    results.tritonbench_commit_sha,
    results.device,
    results.cuda_version,
    results.name,
    results.operator,
    results.suite,
    results.mode,
    results.dtype,
    results.backend,
    results.input_shape,
    results.metric_name,
    results.metric_value,
    DATE_TRUNC(
        {granularity: String},
        fromUnixTimestamp(results.timestamp)
    ) AS granularity_bucket
FROM
    results
ORDER BY
    granularity_bucket DESC,
    workflow_id DESC,
    backend ASC,
    operator ASC
