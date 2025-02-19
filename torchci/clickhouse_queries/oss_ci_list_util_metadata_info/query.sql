SELECT
    workflow_id,
    job_id,
    workflow_name,
    job_name,
    run_attempt,
    repo
FROM
    misc.oss_ci_utilization_metadata
WHERE
    workflow_id = { workflowId: UInt64}
    AND repo = {repo: String }
