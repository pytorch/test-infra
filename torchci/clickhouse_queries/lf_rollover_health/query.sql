-- This query is used to generate a chart on HUD to compare the success, cancellation, and duration rates
-- of jobs in the Meta fleet vs jobs in the LF fleet over time.
WITH
normalized_jobs AS (
  SELECT
    j.started_at,
    ROUND(dateDiff('minute', j.started_at, j.completed_at), 1) as duration_min,
    l as label,
    extract(j.name, '[^,]*') as job_name, -- remove shard number and label from job names
    j.workflow_name,
    j.conclusion,
    toStartOfInterval(j.started_at, INTERVAL 1 DAY) AS bucket
  FROM
    -- Deliberatly not adding FINAL to this workflow_job.
    -- Risks of not using it:
    --   - You may get duplicate records for rows that were updated corresponding to their
    --     before/after states, but as long as there’s some mechanism in the query to account
    --     for that it’s okay (we check for j.status = 'completed`).
    --   - In the worst case scenario, you may only see the ‘old’ version of the records for some rows
    -- Costs of using it:
    --   - Query procesing time increases from ~5 -> 16 seconds
    --   - Memory usage grows from 7.5 GB -> 32 GB
    -- So the tradeoff is worth it for this query.
    workflow_job as j
  ARRAY JOIN
    j.labels as l
  WHERE
    j.labels IS NOT NULL -- prob unnecessary now
    AND j.created_at > now() - interval {days_ago: Int64} day
    AND j.status = 'completed'
    AND l != 'self-hosted'
    AND l NOT LIKE 'lf.c.%'
    AND l NOT LIKE '%canary%'
),
lf_jobs AS (
  SELECT DISTINCT
    j.job_name
  FROM
    normalized_jobs as j
  WHERE
    j.label LIKE 'lf%'
),
comparable_jobs AS (
  SELECT
    j.bucket,
    j.started_at,
    j.duration_min,
    j.label,
    j.job_name,
    j.workflow_name,
    j.conclusion
  FROM
    normalized_jobs as j
  CROSS JOIN lf_jobs as lfj
  WHERE
    j.job_name = lfj.job_name
),
success_stats AS (
  SELECT
    bucket,
    count(*) as group_size,
    job_name,
    workflow_name,
    label,
    if(startsWith(label, 'lf.'), 1, 0 ) as lf_fleet,
    countIf(conclusion = 'success') * 100 / (countIf(conclusion != 'cancelled') + 1) as success_rate, -- plus one is to handle divide by zero errors
    countIf(conclusion = 'failure') * 100 / (countIf(conclusion != 'cancelled') + 1) as failure_rate,
    countIf(conclusion = 'cancelled') * 100 / COUNT() as cancelled_rate,
    avgIf(duration_min, conclusion = 'success') as success_avg_duration,
    avgIf(duration_min, conclusion = 'failure') as failure_avg_duration,
    avgIf(duration_min, conclusion = 'cancelled') as cancelled_avg_duration
  FROM comparable_jobs
  GROUP BY bucket, job_name, workflow_name, label
),
comparison_stats AS (
  SELECT
    lf.bucket,
    lf.workflow_name,
    lf.job_name,
    lf.group_size as sample_size_lf,
    m.group_size as sample_size_meta,
    lf.success_rate - m.success_rate as success_rate_delta,
    lf.failure_rate - m.failure_rate as failure_rate_delta,
    lf.cancelled_rate - m.cancelled_rate as cancelled_rate_delta,
    if(m.success_avg_duration = 0, 1, round(lf.success_avg_duration / m.success_avg_duration, 2)) as success_duration_increase_ratio
  FROM
    success_stats as lf
  JOIN
    success_stats as m
  ON
    lf.bucket = m.bucket
    AND lf.job_name = m.job_name
    AND lf.workflow_name = m.workflow_name
  WHERE
    lf.lf_fleet = 1
    AND m.lf_fleet = 0
    -- the group size limit reduces noise from low sample sizes
    AND lf.group_size > 3
    AND m.group_size > 3
)
SELECT
  *
FROM
  comparison_stats
ORDER BY
  bucket DESC, job_name DESC, success_rate_delta, workflow_name