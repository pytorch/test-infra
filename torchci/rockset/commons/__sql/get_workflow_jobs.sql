SELECT
  job.id,
  job.name,
FROM
  workflow_job job
  INNER JOIN workflow_run workflow on workflow.id = job.run_id HINT(join_strategy = lookup)
WHERE
  workflow.id = :workflowId
  AND job.name LIKE :jobName
ORDER BY
  job.name