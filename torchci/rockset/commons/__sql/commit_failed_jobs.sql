-- This query is used by Dr.CI to get all the failed jobs from the base commit. They can then be
-- used to decide if a failure is due to broken trunk
SELECT
  j.id,
  j.name AS jobName,
  CONCAT(w.name, ' / ', j.name) AS name,
  j.runner_name AS runnerName,
  w.head_commit.author.email as authorEmail,
  j.conclusion,
  j.completed_at,
  j.html_url,
  j.head_sha,
  j.head_branch,
  j.torchci_classification.captures AS failure_captures,
  IF(j.torchci_classification.line IS NULL, null, ARRAY_CREATE(j.torchci_classification.line)) AS failure_lines,
  j._event_time AS time,
FROM
  commons.workflow_job j
  JOIN commons.workflow_run w ON w.id = j.run_id
WHERE
  ARRAY_CONTAINS(
    SPLIT(: shas, ','),
    j.head_sha
  )
  AND j.conclusion IN ('failure', 'cancelled')
