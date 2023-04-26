SELECT
  FORMAT_ISO8601(
      DATE_TRUNC(
          :granularity,
          started_at AT TIME ZONE :timezone
      )
  ) AS started_date,
  project, 
    SUM(DATE_DIFF('SECOND',started_at ,completed_at)) AS duration,
FROM (SELECT
  PARSE_TIMESTAMP_ISO8601(started_at) as started_at,
  PARSE_TIMESTAMP_ISO8601(completed_at) as completed_at,
  ELEMENT_AT(SPLIT(SUBSTR(run_url, 30, 50), '/'), 2) AS project,
  FROM commons.workflow_job
  WHERE
      status = 'completed' AND
      ARRAY_CONTAINS(labels, :label) AND
      runner_group_name = 'GitHub Actions'
  ) AS gha_jobs
WHERE
  started_at >= PARSE_DATETIME_ISO8601(:startTime)
GROUP BY started_date, project
ORDER BY started_date DESC, project
LIMIT 500;