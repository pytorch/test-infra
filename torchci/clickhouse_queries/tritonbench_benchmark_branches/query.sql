-- Build a query
-- This query is used to get the list of branches and commits used by different
-- OSS CI benchmark experiments. This powers TritonBench dashboards
WITH benchmarks AS (
    SELECT
        o.dependencies['triton'].repo AS repo,
        o.dependencies['triton'].branch AS head_branch,
        o.dependencies['triton'].sha AS head_sha,
        o.dependencies['triton'].extra_info['commit_time'] AS commit_time,
        o.workflow_id AS id
    FROM
        benchmark.oss_ci_benchmark_v3 o
    WHERE
        mapContains(o.dependencies, 'tritonbench')
        AND mapContains(o.dependencies, 'triton')
        AND o.timestamp >= {startTime: DateTime64(3)}
        AND o.timestamp < {stopTime: DateTime64(3)}
        AND tupleElement(o.benchmark, 'name') = {benchmark_name: String}
        AND length(commit_time) = 14
)
SELECT DISTINCT
    repo,
    head_branch,
    head_sha,
    commit_time AS event_time,
    id
FROM
    benchmarks
ORDER BY
    head_branch