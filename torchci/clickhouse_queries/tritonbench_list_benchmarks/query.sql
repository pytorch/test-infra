SELECT DISTINCT benchmark.name AS name
FROM
    benchmark.oss_ci_benchmark_v3
WHERE
    timestamp >= toUnixTimestamp({startTime: DateTime64(3) })
    AND timestamp < toUnixTimestamp({stopTime: DateTime64(3) })
    AND mapContains(dependencies, 'tritonbench')
