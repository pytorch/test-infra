-- This query is used by Dr.CI to get all the failed jobs from the base commit. They can then be
-- used to decide if a failure is due to broken trunk
with runs as (
  select
    w.id as id,
    w.head_commit.'author'.'email' as authorEmail,
    w.head_commit.timestamp as head_sha_timestamp
  from default.workflow_run w
  where
    w.id in (select id from materialized_views.workflow_run_by_head_sha where head_sha in {shas: Array(String)})
    and w.head_sha in {shas: Array(String)}
)
SELECT
  j.id as id,
  j.name AS jobName,
  CONCAT(j.workflow_name, ' / ', j.name) AS name,
  j.runner_name AS runnerName,
  w.authorEmail as authorEmail,
  j.conclusion as conclusion,
  j.completed_at as completed_at,
  j.html_url as html_url,
  j.head_sha as head_sha,
  w.head_sha_timestamp AS head_sha_timestamp,
  j.head_branch as head_branch,
  j.torchci_classification.'captures' AS failure_captures,
  IF(j.torchci_classification.'line' = '', [], [j.torchci_classification.'line']) AS failure_lines,
  j.torchci_classification.'context' AS failure_context,
  j.created_at AS time
FROM
  default.workflow_job j final
  JOIN runs w on w.id = j.run_id
WHERE
  j.id in (select id from materialized_views.workflow_job_by_head_sha where head_sha in {shas: Array(String)})
  AND j.conclusion IN ('failure', 'cancelled')
