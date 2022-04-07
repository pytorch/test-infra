SELECT
  flaky_tests.name,
  flaky_tests.suite,
  flaky_tests.file,
  sum(flaky_tests.num_green) AS numGreen,
  sum(flaky_tests.num_red) AS numRed,
  ARRAY_AGG(flaky_tests.workflow_id) AS workflowIds,
  ARRAY_AGG(workflow.name) as workflowNames,
  ARRAY_AGG(flaky_tests.job_id) AS jobIds,
  ARRAY_AGG(job.name) as jobNames,
  ARRAY_AGG(workflow.head_branch) as branches,
FROM commons.flaky_tests flaky_tests JOIN commons.workflow_run workflow on CAST(flaky_tests.workflow_id as int) = workflow.id
	JOIN commons.workflow_job job on CAST(flaky_tests.job_id as int) = job.id
WHERE
	flaky_tests._event_time > (CURRENT_TIMESTAMP() - HOURs(:num_hours)) AND
    flaky_tests.name LIKE :name AND
    flaky_tests.suite LIKE :suite AND
    flaky_tests.file LIKE :file
GROUP BY name, suite, file
ORDER BY flaky_tests.name
