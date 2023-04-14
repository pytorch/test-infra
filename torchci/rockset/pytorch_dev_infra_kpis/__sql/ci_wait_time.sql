WITH percentiles_desired AS (
  -- All the percentiles that we want the query to return
  SELECT 'p25' as percentile, 0.25 as percentile_num
  UNION ALL
  SELECT 'p50', 0.50
  UNION ALL
  SELECT 'p75', 0.75
  UNION ALL
  SELECT 'p90', 0.90
),
-- Set the bucket to the desired granularity
granular_pr_stats as (
    SELECT
      DATE_TRUNC(:granularity, end_time) AS bucket,
      *
    FROM metrics.pr_stats
),
-- Within each bucket, figure out what percentile duration and num_commits each PR falls under
percentiles as (
  SELECT
      pr_number,
      bucket,
      duration_mins,
      PERCENT_RANK() OVER(
          PARTITION BY bucket
          ORDER by duration_mins
      ) as duration_percentile,
      num_commits,
      PERCENT_RANK() OVER(
          PARTITION BY bucket
          ORDER by num_commits
      ) as num_commits_percentile
  FROM
      granular_pr_stats
  WHERE 1 = 1
    AND PARSE_DATETIME_ISO8601(:startTime) <= bucket
    AND DATE(PARSE_DATETIME_ISO8601(:stopTime)) >= bucket 
),
-- For each bucket, get just the durations corresponding to the desired percentiles
duration_percentile as (
  SELECT 
    p.bucket,
    pd.percentile,
    MIN(p.duration_mins) as duration_mins
  FROM percentiles p 
    CROSS JOIN percentiles_desired pd 
  WHERE p.duration_percentile >= pd.percentile_num
  GROUP BY
   p.bucket, pd.percentile
),
-- For each bucket, get just the number of commits corresponding to the desired percentiles
num_commits_percentile as (
  SELECT 
    p.bucket,
    pd.percentile,
    MIN(p.num_commits) as num_commits
  FROM percentiles p 
    CROSS JOIN percentiles_desired pd 
  WHERE p.num_commits_percentile >= pd.percentile_num
  GROUP BY
   p.bucket, pd.percentile
)
-- Keep the percentiles on the same row so that this one query can give the results for both types of data
SELECT 
  FORMAT_TIMESTAMP('%Y-%m-%d', d.bucket) as bucket,
  d.percentile,
  d.duration_mins,
  c.num_commits
FROM 
  duration_percentile d 
  INNER JOIN num_commits_percentile c on d.bucket = c.bucket and d.percentile = c.percentile
WHERE
  d.bucket < (SELECT max(bucket) from granular_pr_stats) -- discard the latest bucket, which will have noisy, partial data
ORDER BY bucket DESC, duration_mins
