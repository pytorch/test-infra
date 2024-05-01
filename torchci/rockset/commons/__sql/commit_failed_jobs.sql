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
  p.head_commit.timestamp AS head_sha_timestamp,
  j.head_branch,
  j.torchci_classification.captures AS failure_captures,
  IF(j.torchci_classification.line IS NULL, null, ARRAY_CREATE(j.torchci_classification.line)) AS failure_lines,
  j.torchci_classification.context AS failure_context,
  j._event_time AS time,
FROM
  commons.workflow_job j
  JOIN commons.workflow_run w ON w.id = j.run_id HINT(join_broadcast = true)
  -- Do a left join here because the push table won't have any information about
  -- commits from forked repo
  LEFT JOIN commons.push p ON p.after = j.head_sha HINT(join_broadcast = true)
WHERE
  ARRAY_CONTAINS(
    SPLIT(: shas, ','),
    j.head_sha
  )
  AND j.conclusion IN ('failure', 'cancelled')
