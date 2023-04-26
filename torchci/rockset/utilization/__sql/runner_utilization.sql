SELECT
      FORMAT_ISO8601(
        DATE_TRUNC(
            :granularity,
            started_at AT TIME ZONE :timezone
        )
    ) AS started_date,
  label,
  SUM(DATE_DIFF('SECOND',started_at,completed_at)) AS duration,
FROM (SELECT
  PARSE_TIMESTAMP_ISO8601(started_at) as started_at,
  PARSE_TIMESTAMP_ISO8601(completed_at) as completed_at,
  ELEMENT_AT(labels, 1) AS label
  FROM commons.workflow_job
  WHERE
      status = 'completed' AND
      runner_group_name = 'GitHub Actions'
  ) AS gha_jobs
WHERE
    started_at >= PARSE_DATETIME_ISO8601(:startTime) AND
    started_at < PARSE_DATETIME_ISO8601(:stopTime)
GROUP BY started_date, label
ORDER BY started_date DESC, label
LIMIT 500;