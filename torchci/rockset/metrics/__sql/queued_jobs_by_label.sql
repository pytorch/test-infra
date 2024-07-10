--- This query is used by HUD metrics page to get the list of queued jobs grouped by their labels
WITH queued_jobs as (
  SELECT
    DATE_DIFF(
      'second',
      job._event_time,
      CURRENT_TIMESTAMP()
    ) AS queue_s,
    CONCAT(workflow.name, ' / ', job.name) AS name,
    job.html_url,
    IF(
      LENGTH(job.labels) = 0,
      IF (
        job.runner_group_name IS NOT null
        AND job.runner_group_name != 'Default'
        AND job.runner_group_name != 'GitHub Actions'
        AND job.runner_group_name != ''
        AND job.runner_group_name != 'linux.rocm.gpu.group',
        job.runner_group_name,
        'N/A'
      ),
      IF(
        LENGTH(job.labels) > 1,
        ELEMENT_AT(job.labels, 2),
        ELEMENT_AT(job.labels, 1)
      )
    ) AS machine_type,
  FROM
    commons.workflow_job job
    JOIN commons.workflow_run workflow ON workflow.id = job.run_id
  WHERE
    workflow.repository.full_name = 'pytorch/pytorch'
    AND job.status = 'queued'
    AND job._event_time < (
      CURRENT_TIMESTAMP() - INTERVAL 5 MINUTE
    )
    /* These two conditions are workarounds for GitHub's broken API. Sometimes */
    /* jobs get stuck in a permanently "queued" state but definitely ran. We can */
    /* detect this by looking at whether any steps executed (if there were, */
    /* obviously the job started running), and whether the workflow was marked as */
    /* complete (somehow more reliable than the job-level API) */
    AND LENGTH(job.steps) = 0
    AND workflow.status != 'completed'
  ORDER BY
    queue_s DESC
)
SELECT
  COUNT(*) AS count,
  MAX(queue_s) AS avg_queue_s,
  machine_type,
  CURRENT_TIMESTAMP() AS time
FROM
  queued_jobs
GROUP BY
  machine_type
ORDER BY
  count DESC
