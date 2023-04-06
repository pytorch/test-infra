WITH flaky_jobs AS (
  SELECT
    -- This commit
    w.name AS workflow_name,
    w.id AS workflow_id,
    job.name AS job_name,
    job.id AS job_id,
    -- The flaky status of the job from the previous commit
    FIRST_VALUE(job.conclusion) OVER(
      PARTITION BY CONCAT(w.name, ' / ', job.name)
      ORDER BY
        push.head_commit.timestamp DESC ROWS BETWEEN CURRENT ROW
        AND 2 FOLLOWING
    ) = 'success'
    AND NTH_VALUE(job.conclusion, 2) OVER(
      PARTITION BY CONCAT(w.name, ' / ', job.name)
      ORDER BY
        push.head_commit.timestamp DESC ROWS BETWEEN CURRENT ROW
        AND 2 FOLLOWING
    ) = 'failure'
    AND LAST_VALUE(job.conclusion) OVER(
      PARTITION BY CONCAT(w.name, ' / ', job.name)
      ORDER BY
        push.head_commit.timestamp DESC ROWS BETWEEN CURRENT ROW
        AND 2 FOLLOWING
    ) = 'success' AS prev_flaky,
    -- Previous commit
    NTH_VALUE(w.id, 2) OVER(
      PARTITION BY CONCAT(w.name, ' / ', job.name)
      ORDER BY
        push.head_commit.timestamp DESC ROWS BETWEEN CURRENT ROW
        AND 2 FOLLOWING
    ) AS prev_workflow_id,
    NTH_VALUE(job.id, 2) OVER(
      PARTITION BY CONCAT(w.name, ' / ', job.name)
      ORDER BY
        push.head_commit.timestamp DESC ROWS BETWEEN CURRENT ROW
        AND 2 FOLLOWING
    ) AS prev_job_id,
    NTH_VALUE(w.run_attempt, 2) OVER(
      PARTITION BY CONCAT(w.name, ' / ', job.name)
      ORDER BY
        push.head_commit.timestamp DESC ROWS BETWEEN CURRENT ROW
        AND 2 FOLLOWING
    ) AS prev_workflow_run_attempt,
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
    AND job.name NOT LIKE '%mem_leak_check%'
    AND job.name NOT LIKE '%rerun_disabled_tests%'
)
SELECT
  DISTINCT flaky_jobs.workflow_name,
  flaky_jobs.prev_workflow_id AS workflow_id,
  flaky_jobs.job_name,
  flaky_jobs.prev_job_id AS job_id,
  flaky_jobs.prev_flaky AS flaky,
  flaky_jobs.prev_workflow_run_attempt AS run_attempt,
  annotation.annotation
FROM
  flaky_jobs
  LEFT JOIN commons.job_annotation annotation on annotation.jobID = flaky_jobs.prev_job_id
WHERE
  (
    (
      flaky_jobs.prev_flaky
      AND annotation.annotation IS NULL
    )
    OR annotation.annotation = 'TEST_FLAKE'
  )
  AND (
    flaky_jobs.job_id = : jobId
    OR : jobId = 0
  )
  AND (
    flaky_jobs.prev_job_id = : previousJobId
    OR : previousJobId = 0
  )
  AND (
    flaky_jobs.prev_workflow_run_attempt = : attempt
    OR : attempt = 0
  )