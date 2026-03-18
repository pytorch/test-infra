SELECT
    toDate(cu.timestamp) AS day,
    COALESCE(wj.workflow_name, cu.event_name) AS workflow_name,
    cu.repo AS repo,
    count(*) AS invocations,
    round(sum(cu.total_cost_usd), 2) AS total_cost,
    sum(cu.num_turns) AS total_turns,
    round(sum(cu.duration_ms) / 1000 / 60, 2) AS total_minutes,
    round(avg(cu.total_cost_usd), 4) AS avg_cost_per_invocation,
    round(avg(cu.num_turns), 1) AS avg_turns_per_invocation
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
GROUP BY
    day,
    workflow_name,
    repo
ORDER BY
    day ASC,
    total_cost DESC
