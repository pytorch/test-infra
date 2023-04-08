WITH dedups AS (
  -- Note that there can be more than one commit with the same ID with the actual author and pytorchmergebot.
  -- This mess up the results in some cases, so this removes all redundant information and only keeps what is
  -- needed for the later query
  SELECT
    DISTINCT CONCAT(w.name, ' / ', job.name) AS fullname,
    w.name AS workflow_name,
    w.id AS workflow_id,
    job.name AS job_name,
    job.id AS job_id,
    job.conclusion AS conclusion,
    push.head_commit.id AS head_commit,
    push.head_commit.timestamp AS head_commit_timestamp,
    job.run_attempt AS run_attempt,
    ROW_NUMBER() OVER(
      PARTITION BY w.id,
      w.name,
      job.name
      ORDER BY
        job.run_attempt DESC
    ) AS row_num,
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
    AND ARRAY_CONTAINS(
      SPLIT(: branches, ','),
      w.head_branch
    )
    AND ARRAY_CONTAINS(
      SPLIT(: workflowNames, ','),
      w.name
    )
    AND job.name NOT LIKE '%mem_leak_check%'
    AND job.name NOT LIKE '%rerun_disabled_tests%'
),
latest_attempts AS (
  -- Keep the latest run attempt to know if the job has already been retried
  SELECT
    *
  FROM
    dedups
  WHERE
    row_num = 1
),
flaky_jobs AS (
  SELECT
    workflow_name,
    job_name,
    -- Next commit
    workflow_id AS next_workflow_id,
    job_id AS next_job_id,
    -- The flaky status of the job
    FIRST_VALUE(conclusion) OVER(
      PARTITION BY fullname
      ORDER BY
        head_commit_timestamp DESC ROWS BETWEEN CURRENT ROW
        AND 2 FOLLOWING
    ) = 'success'
    AND NTH_VALUE(conclusion, 2) OVER(
      PARTITION BY fullname
      ORDER BY
        head_commit_timestamp DESC ROWS BETWEEN CURRENT ROW
        AND 2 FOLLOWING
    ) = 'failure'
    AND LAST_VALUE(conclusion) OVER(
      PARTITION BY fullname
      ORDER BY
        head_commit_timestamp DESC ROWS BETWEEN CURRENT ROW
        AND 2 FOLLOWING
    ) = 'success' AS flaky,
    -- The current commit
    NTH_VALUE(workflow_id, 2) OVER(
      PARTITION BY fullname
      ORDER BY
        head_commit_timestamp DESC ROWS BETWEEN CURRENT ROW
        AND 2 FOLLOWING
    ) AS workflow_id,
    NTH_VALUE(job_id, 2) OVER(
      PARTITION BY fullname
      ORDER BY
        head_commit_timestamp DESC ROWS BETWEEN CURRENT ROW
        AND 2 FOLLOWING
    ) AS job_id,
    NTH_VALUE(run_attempt, 2) OVER(
      PARTITION BY fullname
      ORDER BY
        head_commit_timestamp DESC ROWS BETWEEN CURRENT ROW
        AND 2 FOLLOWING
    ) AS run_attempt,
  FROM
    latest_attempts
  WHERE
    (
      latest_attempts.run_attempt <= : maxAttempt
      OR : maxAttempt = 0
    )
)
SELECT
  DISTINCT flaky_jobs.workflow_name,
  flaky_jobs.workflow_id,
  flaky_jobs.job_name,
  flaky_jobs.job_id,
  flaky_jobs.flaky,
  flaky_jobs.run_attempt,
  flaky_jobs.next_workflow_id,
  flaky_jobs.next_job_id,
  annotation.annotation,
FROM
  flaky_jobs
  LEFT JOIN commons.job_annotation annotation on annotation.jobID = flaky_jobs.job_id
WHERE
  (
    (
      flaky_jobs.flaky
      AND annotation.annotation IS NULL
    )
    OR annotation.annotation = 'TEST_FLAKE'
  )
  AND (
    flaky_jobs.workflow_id = : workflowId
    OR : workflowId = 0
  )
  AND (
    flaky_jobs.next_workflow_id = : nextWorkflowId
    OR : nextWorkflowId = 0
  )