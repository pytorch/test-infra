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
    workflow._event_time AS event_time,
    ROW_NUMBER() OVER(PARTITION BY job.name, push.head_commit.id ORDER BY job.run_attempt DESC) AS attempt,
FROM
  workflow_run workflow
  INNER JOIN commons.workflow_job job ON workflow.id = job.run_id
  INNER JOIN push on workflow.head_commit.id = push.head_commit.id
WHERE
  job._event_time > CURRENT_TIMESTAMP() - INTERVAL 21 DAY
  AND ARRAY_CONTAINS(SPLIT(:workflowNames, ','), LOWER(workflow.name))
  AND workflow.event != 'workflow_run'
  AND push.ref = 'refs/heads/master'
  AND push.repository.owner.name = 'pytorch'
  AND push.repository.name = 'pytorch'
  AND job.name LIKE '%test%'
  AND job.name NOT LIKE '%filter%'
  AND job.name NOT LIKE '%rerun_disabled_tests%'
)
SELECT
  IF (name LIKE '%(%' AND name NOT LIKE '%)%', CONCAT(name, ')'), name) AS name,
  head_sha,
  is_green,
  event_time,
FROM
  all_jobs
WHERE
  is_green IS NOT NULL
  AND attempt = 1
GROUP BY
  name,
  head_sha,
  is_green,
  event_time
ORDER BY
  event_time DESC
