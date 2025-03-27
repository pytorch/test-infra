-- This query is used to get flaky job on trunk so that they can be retried. A flaky job is the
-- one that has the green / red / green pattern. The failure in the middle is considered flaky
-- and can be retried
WITH dedups_wo_push as (
    -- Note that there can be more than one commit with the same ID with the actual author and pytorchmergebot.
    -- This mess up the results in some cases, so this removes all redundant information and only keeps what is
    -- needed for the later query
    SELECT DISTINCT w.name             AS workflow_name,
                    w.id               AS workflow_id,
                    w.head_commit.'id' as head_commit_id,
                    j.name             AS job_name,
                    j.id               AS job_id,
                    CASE
                        WHEN j.conclusion = 'success' THEN 0
                        WHEN j.conclusion = 'failure' THEN 1
                        ELSE 2
                        END            AS conclusion,
                    j.run_attempt      AS run_attempt,
                    ROW_NUMBER() OVER (
                        PARTITION BY w.id, w.name, j.name
                        ORDER BY j.run_attempt DESC
                        )              AS row_num
    FROM (SELECT id, name, head_commit, head_repository, head_branch
          FROM default.workflow_run
          WHERE (created_at >= dateSub(hour, { numHours: Int64 }, CURRENT_DATE()) OR { numHours: Int64 } = 0)
            AND head_repository.'full_name' = { repo: String }
            AND has({branches: Array(String) }, head_branch)
            AND has({workflowNames: Array(String) }, name)
             ) AS w
             JOIN default.workflow_job j FINAL ON w.id = j.run_id
    WHERE (j.created_at >= dateSub(hour, { numHours: Int64 }, CURRENT_DATE()) OR { numHours: Int64 } = 0)
      AND j.name NOT LIKE '%mem_leak_check%'
      AND j.name NOT LIKE '%rerun_disabled_tests%'
      AND j.name NOT LIKE '%unstable%'),
latest_attempts AS (
    select dedups_wo_push.*, push.head_commit.'id' as head_commit_id,
              push.head_commit.'timestamp' as head_commit_timestamp
    from dedups_wo_push
    JOIN default.push FINAL ON push.head_commit.'id' = dedups_wo_push.head_commit_id
    WHERE
        row_num = 1
),
flaky_jobs AS (
    SELECT
        workflow_name,
        job_name,
        -- The flaky status of the job
        FIRST_VALUE(conclusion) OVER(
            PARTITION BY workflow_name, job_name
            ORDER BY
                head_commit_timestamp DESC ROWS BETWEEN CURRENT ROW
                AND 2 FOLLOWING
        ) = 0 /*success*/
        AND NTH_VALUE(conclusion, 2) OVER(
            PARTITION BY workflow_name, job_name
            ORDER BY
                head_commit_timestamp DESC ROWS BETWEEN CURRENT ROW
                AND 2 FOLLOWING
        ) = 1 /*failure*/
        AND LAST_VALUE(conclusion) OVER(
            PARTITION BY workflow_name, job_name
            ORDER BY
                head_commit_timestamp DESC ROWS BETWEEN CURRENT ROW
                AND 2 FOLLOWING
        ) = 0 /*success*/ AS flaky,
        -- The current commit
        NTH_VALUE(workflow_id, 2) OVER(
            PARTITION BY workflow_name, job_name
            ORDER BY
                head_commit_timestamp DESC ROWS BETWEEN CURRENT ROW
                AND 2 FOLLOWING
        ) AS workflow_id,
        NTH_VALUE(job_id, 2) OVER(
            PARTITION BY workflow_name, job_name
            ORDER BY
                head_commit_timestamp DESC ROWS BETWEEN CURRENT ROW
                AND 2 FOLLOWING
        ) AS job_id,
        NTH_VALUE(run_attempt, 2) OVER(
            PARTITION BY workflow_name, job_name
            ORDER BY
                head_commit_timestamp DESC ROWS BETWEEN CURRENT ROW
                AND 2 FOLLOWING
        ) AS run_attempt,
        -- Next commit, this needs to come after the nth_value window functions
        -- above, otherwise, CH query planner croaks about nested the illegal
        -- use of nested window functions
        workflow_id AS next_workflow_id,
        job_id AS next_job_id
    FROM
        latest_attempts
    WHERE
        (
            latest_attempts.run_attempt <= {maxAttempt: Int64}
            OR {maxAttempt: Int64} = 0
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
    annotation.annotation
FROM
    flaky_jobs
    LEFT JOIN default .job_annotation annotation FINAL on annotation.jobID = flaky_jobs.job_id
WHERE
    (
        (
            flaky_jobs.flaky = 1
            AND annotation.annotation = ''
        )
        OR annotation.annotation = 'TEST_FLAKE'
    )
    AND (
        flaky_jobs.workflow_id = {workflowId: Int64}
        OR {workflowId: Int64} = 0
    )
    AND (
        flaky_jobs.next_workflow_id = {nextWorkflowId: Int64}
        OR {nextWorkflowId: Int64} = 0
    )
