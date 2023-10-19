WITH repeats AS (
  SELECT
    array_agg(j.id) AS ids
  FROM
    workflow_run w
    JOIN workflow_job j ON w.id = j.run_id HINT(join_strategy = lookup)
  WHERE
    j._event_time >= PARSE_DATETIME_ISO8601(: startTime)
    AND j._event_time < PARSE_DATETIME_ISO8601(: stopTime)
    AND w.head_repository.full_name = : repo
    AND w.head_branch = : branch
    AND w.event != 'workflow_run'
    AND w.event != 'repository_dispatch'
  GROUP BY
    j.head_sha,
    j.name,
    w.name
  HAVING
    count(*) > : count
    AND bool_or(
      j.conclusion IN (
        'failure', 'cancelled', 'time_out'
      )
    )
),
ids AS (
  SELECT
    ids.id
  FROM
    repeats,
    UNNEST(repeats.ids AS id) AS ids
)
SELECT
  job.head_sha AS sha,
  CONCAT(w.name, ' / ', job.name) AS jobName,
  job.id,
  job.conclusion,
  job.html_url AS htmlUrl,
  CONCAT(
    'https://ossci-raw-job-status.s3.amazonaws.com/log/',
    CAST(job.id AS string)
  ) AS logUrl,
  DATE_DIFF(
    'SECOND',
    PARSE_TIMESTAMP_ISO8601(job.started_at),
    PARSE_TIMESTAMP_ISO8601(job.completed_at)
  ) AS durationS,
  w.repository.full_name AS repo,
  ARRAY_CREATE(job.torchci_classification.line) AS failureLines,
  job.torchci_classification.captures AS failureCaptures,
  ARRAY_CREATE(job.torchci_classification.line_num) AS failureLineNumbers,
FROM
  ids
  JOIN workflow_job job on job.id = ids.id
  INNER JOIN workflow_run w on w.id = job.run_id
WHERE
  job.conclusion IN (
    'failure', 'cancelled', 'time_out'
  )