SELECT
    DATE_TRUNC({granularity: String}, cu.timestamp) AS granularity_bucket,
    cu.repo AS repo,
    count(*) AS invocations,
    round(sum(cu.total_cost_usd), 2) AS total_cost,
    sum(cu.num_turns) AS total_turns,
    round(sum(cu.duration_ms) / 1000 / 60, 2) AS total_minutes
FROM misc.claude_code_usage cu
WHERE
    cu.timestamp >= {startTime: DateTime64(9)}
    AND cu.timestamp < {stopTime: DateTime64(9)}
GROUP BY
    granularity_bucket,
    repo
ORDER BY
    granularity_bucket ASC
