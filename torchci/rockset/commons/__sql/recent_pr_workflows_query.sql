-- This worklow is used by Dr.CI to get all the jobs from pull requests. The failures will then be
-- classified into new failures and unrelated failures such as broken trunk, flaky, unstable, etc.
WITH recent_shas AS (
  SELECT
    distinct pull_request.head.sha AS sha,
    pull_request.number AS number,
    push.head_commit.timestamp AS timestamp,
  FROM
    workflow_job j
    JOIN commons.pull_request pull_request ON j.head_sha = pull_request.head.sha HINT(join_broadcast = true)
    JOIN commons.push push ON j.head_sha = push.after HINT(join_broadcast = true)
  WHERE
    (
      (
        PARSE_TIMESTAMP_ISO8601(j.completed_at) > (
          CURRENT_TIMESTAMP() - MINUTES(: numMinutes)
        )
        AND : prNumber = 0
      )
      OR : prNumber = pull_request.number
    )
    AND pull_request.base.repo.full_name =: repo
)
SELECT
  w.id AS workflowId,
  w.workflow_id as workflowUniqueId,
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
  recent_shas.timestamp AS head_sha_timestamp,
  j.torchci_classification.captures AS failure_captures,
  IF(
    j.torchci_classification.line IS NULL,
    null,
    ARRAY_CREATE(j.torchci_classification.line)
  ) AS failure_lines,
  j.torchci_classification.context AS failure_context,
  j._event_time AS time
FROM
  commons.workflow_run w
  JOIN (
    commons.workflow_job j
    JOIN recent_shas ON j.head_sha = recent_shas.sha HINT(join_broadcast = true)
  ) ON w.id = j.run_id HINT(join_broadcast = true)
UNION
SELECT
  null AS workflowId,
  w.workflow_id as workflowUniqueId,
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
  recent_shas.timestamp AS head_sha_timestamp,
  null AS failure_captures,
  null AS failure_lines,
  null AS failure_context,
  w._event_time as time
FROM
  commons.workflow_run w
  JOIN recent_shas ON w.head_sha = recent_shas.sha HINT(join_broadcast = true)
ORDER BY
  time DESC
