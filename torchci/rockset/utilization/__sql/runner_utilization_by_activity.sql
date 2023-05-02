SELECT
  FORMAT_ISO8601(
      DATE_TRUNC(
          :granularity,
          started_at AT TIME ZONE :timezone
      )
  ) AS started_date,
  activity,
  SUM(DATE_DIFF('SECOND',started_at, completed_at)) AS duration,
FROM (SELECT
  PARSE_TIMESTAMP_ISO8601(started_at) as started_at,
  PARSE_TIMESTAMP_ISO8601(completed_at) as completed_at,
  IF(head_branch like 'ciflow/%',
    CONCAT('ciflow/', ELEMENT_AT(SPLIT(head_branch, '/'), 2)),
    -- workaround for missing event_type property
    -- If head_branch does not start with ciflow/periodic but workflow name is
    -- then it must be running as result of scheduled event
    IF(workflow_name = 'periodic', 'periodic', head_branch)
  ) as activity
  FROM commons.workflow_job
  WHERE
      status = 'completed' AND
      ARRAY_CONTAINS(labels, :label) AND
      SUBSTR(run_url, 30, 15) = 'pytorch/pytorch' AND
      runner_group_name = 'GitHub Actions' AND
      PARSE_DATETIME_ISO8601(started_at) >= PARSE_DATETIME_ISO8601(:startTime) AND
      PARSE_DATETIME_ISO8601(started_at) < PARSE_DATETIME_ISO8601(:stopTime)
  ) AS gha_jobs
GROUP BY started_date, activity
ORDER BY started_date DESC, activity
LIMIT 500;