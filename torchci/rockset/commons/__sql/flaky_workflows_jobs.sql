WITH failed_jobs AS (
  SELECT
    FIRST_VALUE(job.conclusion) OVER(
      PARTITION BY CONCAT(w.name, ' / ', job.name)
      ORDER BY
        push.head_commit.timestamp ROWS BETWEEN 1 PRECEDING
        AND 1 FOLLOWING
    ) = 'success'
    AND NTH_VALUE(job.conclusion, 2) OVER(
      PARTITION BY CONCAT(w.name, ' / ', job.name)
      ORDER BY
        push.head_commit.timestamp ROWS BETWEEN 1 PRECEDING
        AND 1 FOLLOWING
    ) = 'failure'
    AND LAST_VALUE(job.conclusion) OVER(
      PARTITION BY CONCAT(w.name, ' / ', job.name)
      ORDER BY
        push.head_commit.timestamp ROWS BETWEEN 1 PRECEDING
        AND 1 FOLLOWING
    ) = 'success' AS flaky,
    job.id,
    job.name AS jobname,
    w.id AS workflow_id,
    w.name AS workflow_name,
    w.run_attempt AS workflow_run_attempt,
  FROM
    commons.workflow_run w
    JOIN commons.workflow_job job ON w.id = job.run_id HINT(join_strategy = lookup)
    JOIN push ON push.head_commit.id = w.head_commit.id
  WHERE
    (
      job._event_time >= CURRENT_DATE() - HOURS(: numHours)
      OR : numHours = 0
    )
    AND w.head_repository.full_name = : repo
    AND w.head_branch = : branch
    AND ARRAY_CONTAINS(
      SPLIT(: workflowNames, ','),
      w.name
    )
    AND (
      w.run_attempt = : attempt
      OR : attempt = 0
    )
    AND job.name NOT LIKE '%mem_leak_check%'
    AND job.name NOT LIKE '%rerun_disabled_tests%'
)
SELECT
  DISTINCT failed_jobs.*,
  annotation.annotation
FROM
  failed_jobs
  LEFT JOIN commons.job_annotation annotation on annotation.jobID = failed_jobs.id
WHERE
  (
    (
      failed_jobs.flaky
      AND annotation.annotation IS NULL
    )
    OR annotation.annotation = 'TEST_FLAKE'
  )
  AND (
    failed_jobs.id = : jobId
    OR : jobId = 0
  )