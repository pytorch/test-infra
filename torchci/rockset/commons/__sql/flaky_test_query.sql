SELECT 
  flaky_tests.name,
  flaky_tests.suite,
  flaky_tests.file,
  sum(flaky_tests.num_green) AS "num_green",
  sum(flaky_tests.num_red) AS "num_red",
  ARRAY_AGG(flaky_tests.workflow_id) AS workflow_ids,
  ARRAY_AGG(workflow.name) as workflow_names,
  ARRAY_AGG(workflow.head_branch) as branches,
FROM commons.flaky_tests flaky_tests JOIN commons.workflow_run workflow on CAST(flaky_tests.workflow_id as int) = workflow.id
WHERE 
	flaky_tests._event_time > (CURRENT_TIMESTAMP() - HOURs(:num_hours)) AND
    flaky_tests.name LIKE :name AND
    flaky_tests.suite LIKE :suite AND
    flaky_tests.file LIKE :file
GROUP BY name, suite, file