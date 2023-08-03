-- This worklow is used by Dr.CI to get all the failed jobs from the base commit. They can then be
-- used to decide if a failure is due to broken trunk
SELECT
  j.id,
  j.name,
  j.conclusion,
  j.completed_at,
  j.html_url,
  j.head_sha,
  j.torchci_classification.captures AS failure_captures,
  j.torchci_classification.line AS failure_line,
FROM
  commons.workflow_job j
WHERE
  ARRAY_CONTAINS(
    SPLIT(: shas, ','),
    j.head_sha
  )
  AND j.conclusion IN ('failure', 'cancelled')