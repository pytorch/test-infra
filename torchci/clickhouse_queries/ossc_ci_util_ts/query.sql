
--- This query is used by utilization dashboard
SELECT
    time_stamp AS ts,
    tags,
    json_data AS data,
FROM
    fortesting.oss_ci_utilization_metadata
WHERE
    workflow_id = { workflowId: UInt64}
    And run_attempt = {run_attempt: UInt32}
    And job_id = {job_id: UInt64}
    AND repo = {repo: String }
    AND type = {type: String}
ORDER BY
    ts
