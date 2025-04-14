-- This query is used to get the list of branches and commits used by different
-- OSS CI benchmark experiments. This powers TritonBench dashboards
WITH benchmarks AS (
    SELECT
        o.head_branch AS head_branch,
        o.head_sha AS head_sha,
        o.workflow_id AS id,
        toStartOfDay(fromUnixTimestamp(o.timestamp)) AS event_time
    FROM
        benchmark.oss_ci_benchmark_v3 o
    WHERE
        o.timestamp >= toUnixTimestamp({startTime: DateTime64(3) })
        AND o.timestamp < toUnixTimestamp({stopTime: DateTime64(3) })
        AND o.repo = {repo: String }
        AND tupleElement(o.benchmark, 'name') = {benchmark_name: String}
)

SELECT DISTINCT
    replaceOne(head_branch, 'refs/heads/', '') AS head_branch,
    head_sha,
    id,
    event_time
FROM
    benchmarks
ORDER BY
    head_branch,
    event_time DESC
