SELECT
  COUNT(*) AS COUNT,
  job.name
FROM
  workflow_job job
  JOIN workflow_run workflow ON workflow.id = job.run_id
  join push on push.head_commit.'id' = workflow.head_commit.'id'
WHERE
  job.name NOT LIKE '%generate-matrix%'
  AND job.name NOT LIKE '%unittests%'
  AND workflow.name NOT IN ('cron', 'Bandit', 'tests')
  AND push.ref = 'refs/heads/nightly'
  AND push.repository.'owner'.'name' = 'pytorch'
  AND job.conclusion IN ('failure', 'timed_out', 'cancelled')
  AND job.completed_at >= today() - 1
GROUP BY job.name
ORDER BY COUNT;
