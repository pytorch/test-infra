--- This query is used by utilization dashboard
SELECT
    usage_collect_interval AS collect_interval,
    data_model_version AS model_version,
    gpu_count,
    cpu_count,
    created_at,
    workflow_name,
    job_name,
    start_at,
    end_at,
    tags
FROM
    fortesting.oss_ci_utilization_metadata
WHERE
    workflow_id = { workflowId: UInt64}
    And run_attempt = {run_attempt: UInt32}
    And job_id = {job_id: UInt64}
    AND repo = {repo: String }
    AND type = {type: String}
