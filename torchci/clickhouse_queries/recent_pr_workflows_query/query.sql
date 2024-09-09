-- This workflow is used by Dr.CI to get all the jobs from pull requests. The failures will then be
-- classified into new failures and unrelated failures such as broken trunk, flaky, unstable, etc.
WITH relevant_shas as (
  select head_sha
  from materialized_views.workflow_job_by_completed_at
  where completed_at > now() - Interval {numMinutes: Int64} MINUTES
  and {prNumber: Int64} = 0
  union all
  select pr.head.'sha' as head_sha
  from default.pull_request pr final
  where pr.number = {prNumber: Int64}
),
relevant_pushes as (
  -- optimization because push is currently ordered by timestamp
  select push.head_commit.'timestamp' as timestamp, push.head_commit.'id' as id
  from default.push final
  where push.head_commit.'timestamp' in (select timestamp from materialized_views.push_by_sha where id in relevant_shas)
),
recent_prs AS (
  SELECT
    distinct pull_request.head.'sha' AS sha,
    pull_request.number AS number,
    push.timestamp AS timestamp
  FROM
    relevant_shas r
    JOIN default.pull_request pull_request final ON r.head_sha = pull_request.head.'sha'
    -- Do a left join here because the push table won't have any information about
    -- commits from forked repo
    LEFT JOIN relevant_pushes push ON r.head_sha = push.id
  WHERE
    pull_request.base.'repo'.'full_name' = {repo: String}
    -- Filter pull request table to be smaller to amke query faster
    and pull_request.number in (select number from materialized_views.pr_by_sha where head_sha in (select head_sha from relevant_shas))
)
SELECT
  w.id AS workflowId,
  w.workflow_id as workflowUniqueId,
  j.id as id,
  j.runner_name AS runnerName,
  w.head_commit.'author'.'email' as authorEmail,
  CONCAT(w.name, ' / ', j.name) AS name,
  j.name AS jobName,
  j.conclusion as conclusion,
  j.completed_at as completed_at,
  j.html_url as html_url,
  j.head_branch as head_branch,
  recent_prs.number AS pr_number,
  recent_prs.sha AS head_sha,
  recent_prs.timestamp AS head_sha_timestamp,
  j.torchci_classification.'captures' AS failure_captures,
  IF(
    j.torchci_classification.'line' = '',
    [],
    [j.torchci_classification.'line']
  ) AS failure_lines,
  j.torchci_classification.'context' AS failure_context,
  j.created_at AS time
FROM
  default.workflow_run w final
  JOIN default.workflow_job j final ON w.id = j.run_id
  JOIN recent_prs ON j.head_sha = recent_prs.sha
where
  w.id in (select id from materialized_views.workflow_run_by_head_sha where head_sha in (select sha from recent_prs))
  and j.id in (select id from materialized_views.workflow_job_by_head_sha where head_sha in (select sha from recent_prs))
UNION all
SELECT
  0 AS workflowId,
  w.workflow_id as workflowUniqueId,
  w.id as id,
  '' AS runnerName,
  w.head_commit.'author'.'email' as authorEmail,
  w.name AS name,
  w.name AS jobName,
  w.conclusion as conclusion,
  toDateTime64(0, 9) as completed_at,
  w.html_url as html_url,
  w.head_branch as head_branch,
  recent_prs.number AS pr_number,
  w.head_sha AS head_sha,
  recent_prs.timestamp AS head_sha_timestamp,
  [] AS failure_captures,
  [] AS failure_lines,
  [] AS failure_context,
  w.created_at as time
FROM
  default.workflow_run w final
  JOIN recent_prs ON w.head_sha = recent_prs.sha
WHERE
  w.id in (select id from materialized_views.workflow_run_by_head_sha where head_sha in (select sha from recent_prs))
ORDER BY
  time DESC
-- Non experimental analyzer has problems with final...
SETTINGS allow_experimental_analyzer=1
