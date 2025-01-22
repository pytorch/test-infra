-- This query is used to get the list of branches and commits used by different
-- OSS CI benchmark experiments. This powers HUD TorchAO benchmarks dashboards
WITH benchmarks AS (
    SELECT
        o.head_branch AS head_branch,
        o.head_sha AS head_sha,
        o.workflow_id AS id,
        TOSTARTOFDAY(FROMUNIXTIMESTAMP(o.timestamp)) AS event_time
    FROM
        benchmark.oss_ci_benchmark_v3 o
    WHERE
        o.timestamp >= TOUNIXTIMESTAMP({startTime: DateTime64(3) })
        AND o.timestamp < TOUNIXTIMESTAMP({stopTime: DateTime64(3) })
        AND o.repo = {repo: String }
        AND TUPLEELEMENT(o.benchmark, 'extra_info')['performance'] = 'true'
        AND (
            HAS(
                {dtypes: Array(String) },
                TUPLEELEMENT(o.benchmark, 'extra_info')['quantization']
            )
            OR EMPTY({dtypes: Array(String) })
        )
        AND TUPLEELEMENT(o.benchmark, 'mode') = {mode: String }
        AND TUPLEELEMENT(o.benchmark, 'extra_info')['device']
        = {device: String }
)

SELECT DISTINCT
    REPLACEONE(head_branch, 'refs/heads/', '') AS head_branch,
    head_sha,
    id,
    event_time
FROM
    benchmarks
ORDER BY
    head_branch,
    event_time DESC
