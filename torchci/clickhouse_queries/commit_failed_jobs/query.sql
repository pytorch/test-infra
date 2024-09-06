-- This query is used by Dr.CI to get all the failed jobs from the base commit. They can then be
-- used to decide if a failure is due to broken trunk
with relevant_pushes as (
  select
    p.head_commit.timestamp as timestamp,
    p.head_commit.'id' as after
  from default.push p final
  where
    p.head_commit.'id' in {shas: Array(String)}
)
SELECT
  j.id as id,
  j.name AS jobName,
  CONCAT(w.name, ' / ', j.name) AS name,
  j.runner_name AS runnerName,
  w.head_commit.'author'.'email' as authorEmail,
  j.conclusion as conclusion,
  j.completed_at as completed_at,
  j.html_url as html_url,
  j.head_sha as head_sha,
  p.timestamp AS head_sha_timestamp,
  j.head_branch as head_branch,
  j.torchci_classification.'captures' AS failure_captures,
  IF(j.torchci_classification.'line' = '', [], [j.torchci_classification.'line']) AS failure_lines,
  j.torchci_classification.'context' AS failure_context,
  j.created_at AS time
FROM
  default.workflow_run w final
  JOIN default.workflow_job j final ON w.id = j.run_id
  -- Do a left join here because the push table won't have any information about
  -- commits from forked repo
  LEFT JOIN relevant_pushes p ON p.after = j.head_sha
WHERE
  j.id in (select id from materialized_views.workflow_job_by_head_sha where head_sha in {shas: Array(String)})
  and w.id in (select id from materialized_views.workflow_run_by_head_sha where head_sha in {shas: Array(String)})
  AND j.conclusion IN ('failure', 'cancelled')
