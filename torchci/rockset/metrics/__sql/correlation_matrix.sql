WITH all_jobs AS (
  SELECT
    CONCAT(
      workflow.name,
      ' / ',
      ELEMENT_AT(SPLIT(job.name, ' / '), 1),
      IF(
        job.name LIKE '%/%',
        CONCAT(' / ', ELEMENT_AT(SPLIT(ELEMENT_AT(SPLIT(job.name, ' / '), 2), ', '), 1)),
        ''
      )
    ) AS name,
    workflow.head_sha,
    CASE
      WHEN job.conclusion = 'failure' THEN 0
      WHEN job.conclusion = 'timed_out' THEN 0
      WHEN job.conclusion = 'cancelled' THEN 0
      WHEN job.conclusion IS NULL THEN NULL
      WHEN job.conclusion = 'skipped' THEN NULL
      ELSE 1
    END AS is_green,
FROM
  workflow_run workflow
  INNER JOIN commons.workflow_job job ON workflow.id = job.run_id
WHERE
  job._event_time > CURRENT_TIMESTAMP() - INTERVAL 21 DAY
  AND ARRAY_CONTAINS(SPLIT(:workflowNames, ','), LOWER(workflow.name))
  AND job.name LIKE '%test%'
)
SELECT
  IF (name LIKE '%(%' AND name NOT LIKE '%)%', CONCAT(name, ')'), name) AS name,
  head_sha,
  is_green,
FROM
  all_jobs
GROUP BY
  name,
  head_sha,
  is_green
