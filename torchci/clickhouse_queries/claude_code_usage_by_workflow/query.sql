SELECT
    DATE_TRUNC({granularity: String}, cu.timestamp) AS granularity_bucket,
    COALESCE(wj.workflow_name, cu.event_name) AS workflow_name,
    count(*) AS invocations,
    round(sum(cu.total_cost_usd), 2) AS total_cost,
    sum(cu.num_turns) AS total_turns,
    round(sum(cu.duration_ms) / 1000 / 60, 2) AS total_minutes
FROM misc.claude_code_usage cu
LEFT JOIN (
    SELECT DISTINCT
        run_id,
        run_attempt,
        workflow_name
    FROM default.workflow_job
) wj ON cu.run_id = wj.run_id AND cu.run_attempt = wj.run_attempt
WHERE
    cu.timestamp >= {startTime: DateTime64(9)}
    AND cu.timestamp < {stopTime: DateTime64(9)}
    AND cu.repo IN {selectedRepos: Array(String)}
GROUP BY
    granularity_bucket,
    workflow_name
ORDER BY
    granularity_bucket ASC
