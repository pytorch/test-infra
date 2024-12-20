-- !!! Query is not converted to CH syntax yet.  Delete this line when it gets converted

WITH normalized_jobs AS (
  SELECT
    j.started_at,
    ROUND(DATE_DIFF('MINUTE', PARSE_TIMESTAMP_ISO8601(j.started_at), PARSE_TIMESTAMP_ISO8601(j.completed_at)), 1) as duration_min,
    if(
        strpos(l.label, 'amz2023.') = 0,
        l.label,
        CONCAT(
            substr(l.label, 1, strpos(l.label, 'amz2023.') - 1),
            substr(l.label, length('amz2023.') + strpos(l.label, 'amz2023.'))
        )
    ) as label,
    REGEXP_EXTRACT(j.name, '([^,]*),?', 1) as job_name, -- remove shard number and label from job names
    j.workflow_name,
    j.conclusion,
      DATE_TRUNC(:granularity, PARSE_TIMESTAMP_ISO8601(j.started_at))
    AS bucket,
  FROM
      commons.workflow_job j
      CROSS JOIN UNNEST(j.labels as label) as l
  WHERE 1=1
    AND j.labels is not NULL
    AND j._event_time > CURRENT_DATETIME() - DAYS(:days_ago)
    AND j.status = 'completed'
    AND l.label != 'self-hosted'
    AND l.label not like 'lf.c.%'
    AND l.label not like '%canary%'

), migrated_jobs AS (
  SELECT DISTINCT
    j.job_name
  FROM
      normalized_jobs j
  WHERE 1=1
    AND j.label like 'lf%'
), comparable_jobs AS (
      SELECT
        -- count(*)
        j.bucket,
        j.started_at,
        j.duration_min,-- -- j.completed_at,
        j.label,
        j.job_name, -- remove shard number and label from job names
        j.workflow_name,
        j.conclusion,
      FROM
        normalized_jobs j
        CROSS JOIN migrated_jobs mj
      WHERE 1 = 1
        AND j.job_name = mj.job_name
        -- AND STRPOS(j.name, mj.job_clean) > 0

), success_stats AS (
  SELECT
    bucket,
    count(*) as group_size,
    job_name,
    workflow_name,
    label,
    IF(SUBSTR(label, 1, 3) = 'lf.', True, False ) as lf_fleet,
    SUM(
        CASE
            WHEN conclusion = 'success' THEN 1
            ELSE 0
        END
    ) * 100 / (COUNT_IF(conclusion != 'cancelled') + 1) as success_rate, -- plus one is to handle divide by zero errors
    SUM(
        CASE
            WHEN conclusion = 'failure' THEN 1
            ELSE 0
        END
    ) * 100 / (COUNT_IF(conclusion != 'cancelled') + 1) as failure_rate,
    SUM(
        CASE
            WHEN conclusion = 'cancelled' THEN 1
            ELSE 0
        END
    ) * 100 / COUNT(*) as cancelled_rate, -- cancelled rate is calculated over all jobs
    SUM(
        CASE
            WHEN conclusion = 'success' THEN 1
            ELSE 0
        END
    ) as success_count,
    SUM(
        CASE
            WHEN conclusion = 'failure' THEN 1
            ELSE 0
        END
    ) as failure_count,
    SUM(
        CASE
            WHEN conclusion = 'cancelled' THEN 1
            ELSE 0
        END
    ) as cancelled_count,
    COUNT(*) as total_count,
    SUM(
        CASE
            WHEN conclusion = 'success' THEN duration_min
            ELSE 0
        END
    ) / COUNT(*) as success_avg_duration,
    SUM(
        CASE
            WHEN conclusion = 'failure' THEN duration_min
            ELSE 0
        END
    ) / COUNT(*) as failure_avg_duration,
    SUM(
        CASE
            WHEN conclusion = 'cancelled' THEN duration_min
            ELSE 0
        END
    ) / COUNT(*) as cancelled_avg_duration,

  FROM comparable_jobs
  GROUP BY
    bucket, job_name, workflow_name, label
), comparison_stats AS (
    SELECT
        lf.bucket,
        lf.workflow_name,
        lf.job_name,
        lf.group_size as sample_size_lf,
        m.group_size as sample_size_meta,
        lf.success_rate - m.success_rate as success_rate_delta,
        lf.failure_rate - m.failure_rate as failure_rate_delta,
        lf.cancelled_rate - m.cancelled_rate as cancelled_rate_delta,
        IF(m.success_avg_duration = 0, 1, ROUND(lf.success_avg_duration * 1.0 / m.success_avg_duration, 2)) as success_duration_increase_ratio,
    FROM success_stats lf
    INNER JOIN success_stats m on lf.bucket = m.bucket
    WHERE 1 = 1
        AND lf.job_name = m.job_name
        AND lf.workflow_name = m.workflow_name
        AND lf.lf_fleet = True
        AND m.lf_fleet = False
        AND lf.group_size > 3
        AND m.group_size > 3
)
SELECT * from comparison_stats
ORDER by bucket desc, job_name desc, success_rate_delta, workflow_name
