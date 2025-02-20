-- A simple query to get a job by name
SELECT DISTINCT
    job.id,
    job.name
FROM
    default.workflow_job job FINAL
INNER JOIN workflow_run workflow FINAL ON workflow.id = job.run_id
WHERE
    workflow.id = { workflowId: Int64 }
    AND job.name LIKE { jobName: String }
ORDER BY
    job.name
