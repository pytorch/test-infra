-- This query is used by Dr.CI to get all the failed jobs from the base commit. They can then be
-- used to decide if a failure is due to broken trunk
SELECT
  j.id,
  j.name as jobName,
  CONCAT(w.name, ' / ', j.name) as name,
  j.conclusion,
  j.completed_at,
  j.html_url,
  j.head_sha,
  j.head_branch,
  j.torchci_classification.captures AS failure_captures,
  j.torchci_classification.line AS failure_line,
  j._event_time as time,
FROM
  commons.workflow_job j
  join commons.workflow_run w on w.id = j.run_id
WHERE
  ARRAY_CONTAINS(
    SPLIT(: shas, ','),
    j.head_sha
  )
  AND j.conclusion IN ('failure', 'cancelled')
