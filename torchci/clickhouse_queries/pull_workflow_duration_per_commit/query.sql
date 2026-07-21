WITH
pull_workflow_durations AS (
  SELECT
    MAX(
      DATE_DIFF(
        'second',
        w.created_at,
        w.updated_at
      )
    ) / 60.0 AS duration_mins,
    w.head_sha,
    MIN(w.created_at) AS created_at
  FROM
    default.workflow_run w final
  WHERE
    lower(w.name) = 'pull'
    AND w.head_branch = 'main'
    AND w.created_at >= {startTime: DateTime64(3)}
    AND w.created_at < {stopTime: DateTime64(3)}
    AND w.head_repository.full_name = 'pytorch/pytorch'
    AND w.id IN (
      SELECT id
      FROM materialized_views.workflow_run_by_created_at
      WHERE created_at >= {startTime: DateTime64(3)}
        AND created_at < {stopTime: DateTime64(3)}
    )
  GROUP BY
    w.head_sha
),
percentiles AS (
  SELECT
    toStartOfWeek(d.created_at, 0) AS bucket,
    quantileExact(0.5)(d.duration_mins) AS p50,
    quantileExact(0.9)(d.duration_mins) AS p90
  FROM
    pull_workflow_durations d
  GROUP BY
    bucket
)
SELECT
  formatDateTime(p.bucket, '%Y-%m-%d') AS bucket,
  p.p50,
  p.p90
FROM
  percentiles p
WHERE
  p.bucket < CURRENT_TIMESTAMP() - INTERVAL 1 WEEK
ORDER BY
  bucket DESC
