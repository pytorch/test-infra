--- This query is used by HUD metrics page to get the list of queued jobs
with possible_queued_jobs as (
  select id, run_id
  from default.workflow_job -- FINAL not needed since we just use this to filter a table that has already been FINALed
  where status = 'queued'
    AND created_at < (CURRENT_TIMESTAMP() - INTERVAL 5 MINUTE)
    AND created_at > (CURRENT_TIMESTAMP() - INTERVAL 1 WEEK)
)
SELECT
  DATE_DIFF(
    'second',
    job.created_at,
    CURRENT_TIMESTAMP()
  ) AS queue_s,
  CONCAT(workflow.name, ' / ', job.name) AS name,
  job.html_url,
  IF(
    LENGTH(job.labels) = 0,
    'N/A',
    IF(
      LENGTH(job.labels) > 1,
      job.labels[2],
      job.labels[1]
    )
  ) AS machine_type
FROM
  default.workflow_job job final
  JOIN default.workflow_run workflow final ON workflow.id = job.run_id
WHERE
  job.id in (select id from possible_queued_jobs)
  and workflow.id in (select run_id from possible_queued_jobs)
  and workflow.repository.'full_name' = 'pytorch/pytorch'
  AND job.status = 'queued'
  /* These two conditions are workarounds for GitHub's broken API. Sometimes */
  /* jobs get stuck in a permanently "queued" state but definitely ran. We can */
  /* detect this by looking at whether any steps executed (if there were, */
  /* obviously the job started running), and whether the workflow was marked as */
  /* complete (somehow more reliable than the job-level API) */
  AND LENGTH(job.steps) = 0
  AND workflow.status != 'completed'
ORDER BY
  queue_s DESC
settings allow_experimental_analyzer = 1;
