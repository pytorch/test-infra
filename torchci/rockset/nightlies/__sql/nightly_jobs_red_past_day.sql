SELECT
  COUNT(*) COUNT,
  job.name
FROM
  commons.workflow_job job
  JOIN commons.workflow_run workflow on workflow.id = job.run_id
  JOIN push on workflow.head_commit.id = push.head_commit.id
WHERE
  job.name NOT LIKE '%generate-matrix%'
  AND job.name NOT LIKE '%unittests%'
  AND workflow.name NOT IN ('cron', 'Bandit', 'tests')
  AND push.ref = 'refs/heads/nightly'
  AND push.repository.owner.name = 'pytorch'
  AND push.repository.name = :repo
  AND job.conclusion in ('failure', 'timed_out', 'cancelled') 
  AND job._event_time >= CURRENT_DATE() - INTERVAL 1 DAY
GROUP BY job.name
ORDER BY COUNT

