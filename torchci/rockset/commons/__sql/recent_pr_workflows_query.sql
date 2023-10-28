-- This worklow is used by Dr.CI to get all the jobs from pull requests. The failures will then be
-- classified into new failures and unrelated failures such as broken trunk, flaky, unstable, etc.
WITH recent_shas AS (
  SELECT
    p.head.sha AS sha,
    p.number AS number
  FROM
    workflow_job j
    JOIN commons.pull_request p ON j.head_sha = p.head.sha
  WHERE
    (
      (
        PARSE_TIMESTAMP_ISO8601(j.completed_at) > (
          CURRENT_TIMESTAMP() - MINUTES(: numMinutes)
        )
        AND : prNumber = 0
      )
      OR : prNumber = p.number
    )
    AND p.base.repo.full_name = : repo
)
SELECT
  w.id AS workflowId,
  j.id,
  j.runner_name AS runnerName,
  w.head_commit.author.email as authorEmail,
  CONCAT(w.name, ' / ', j.name) AS name,
  j.name AS jobName,
  j.conclusion,
  j.completed_at,
  j.html_url,
  j.head_branch,
  recent_shas.number AS pr_number,
  recent_shas.sha AS head_sha,
  j.torchci_classification.captures AS failure_captures,
  j.torchci_classification.line AS failure_line,
  j._event_time AS time
FROM
  recent_shas
  JOIN commons.workflow_job j ON j.head_sha = recent_shas.sha
  JOIN commons.workflow_run w ON w.id = j.run_id
UNION
SELECT
  null AS workflowId,
  w.id,
  null AS runnerName,
  w.head_commit.author.email as authorEmail,
  w.name AS name,
  w.name AS jobName,
  w.conclusion,
  w.completed_at,
  w.html_url,
  w.head_branch,
  recent_shas.number AS pr_number,
  w.head_sha,
  null AS failure_captures,
  null AS failure_line,
  w._event_time as time
FROM
  recent_shas
  JOIN commons.workflow_run w ON w.head_sha = recent_shas.sha
ORDER BY
  time DESC