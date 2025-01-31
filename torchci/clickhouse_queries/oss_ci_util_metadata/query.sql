--- This query is used by utilization dashboard
-- TODO(): change to misc. once the pipeline is ready, currently fetch data from fortesting for development
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
    segments,
    tags
FROM
    fortesting.oss_ci_utilization_metadata
WHERE
    workflow_id = { workflowId: UInt64}
    And run_attempt = {runAttempt: UInt32}
    And job_id = {jobId: UInt64}
    AND repo = {repo: String }
