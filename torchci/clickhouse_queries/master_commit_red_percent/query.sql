-- huydhn: This query tracks the number of red commits on HUD KPIs page.
WITH pushes AS ( -- very selective
    select
        p.head_commit. 'timestamp' AS time,
        p.head_commit. 'id' AS sha
    from
        default .push p FINAL
    where
        p.ref = 'refs/heads/main'
        and p.repository. 'owner'.'name' = 'pytorch'
        and p.repository. 'name' = 'pytorch'
        and p.head_commit. 'timestamp' >= {startTime: DateTime64(3) }
        and p.head_commit. 'timestamp' < {stopTime: DateTime64(3) }
),
all_jobs AS (
    SELECT
        p.time AS time,
        j.conclusion AS conclusion,
        j.head_sha AS sha,
        ROW_NUMBER() OVER(
            PARTITION BY j.name,
            j.head_sha
            ORDER BY
                j.run_attempt DESC
        ) AS row_num
    FROM
        default .workflow_job j FINAL
        join pushes p FINAL on j.head_sha = p.sha
    WHERE
        j.id in (
            SELECT id FROM materialized_views.workflow_job_by_head_sha
            WHERE head_sha in (SELECT distinct p.sha FROM pushes p)
        )
        AND j.workflow_event != 'workflow_run' -- Filter out worflow_run-triggered jobs, which have nothing to do with the SHA
        AND (
            -- Limit it to jobs which block viable/strict upgrades
            has({workflowNames: Array(String) }, lower(j.workflow_name))
            OR j.workflow_name like 'linux-binary%'
        )
        AND j.name != 'ciflow_should_run'
        AND j.name != 'generate-test-matrix'
        AND j.name NOT LIKE '%rerun_disabled_tests%'
        AND j.name NOT LIKE '%unstable%'
),
any_red AS (
    SELECT
        formatDateTime(DATE_TRUNC({granularity: String }, time), '%Y-%m-%d') AS granularity_bucket,
        sha,
        CAST(
            SUM(
                CASE
                    WHEN conclusion = 'failure' THEN 1
                    WHEN conclusion = 'timed_out' THEN 1
                    WHEN conclusion = 'cancelled' THEN 1
                    ELSE 0
                END
            ) > 0 AS int
        ) AS all_red,
        CAST(
            SUM(
                CASE
                    WHEN conclusion = 'failure'
                    AND row_num = 1 THEN 1
                    WHEN conclusion = 'timed_out'
                    AND row_num = 1 THEN 1
                    WHEN conclusion = 'cancelled'
                    AND row_num = 1 THEN 1
                    ELSE 0
                END
            ) > 0 AS int
        ) AS broken_trunk_red
    FROM
        all_jobs
    GROUP BY
        granularity_bucket,
        sha
    HAVING
        count(sha) > 10 -- Filter out jobs that didn't run anything.
        AND SUM(IF(conclusion is NULL, 1, 0)) = 0 -- Filter out commits that still have pending jobs.
),
classified_red AS (
    SELECT
        granularity_bucket,
        -- CH only allows data of the same type in the array
        arrayJoin(
            array(
                array('Broken trunk', toString(AVG(broken_trunk_red))),
                array(
                    'Flaky',
                    toString(AVG(all_red) - AVG(broken_trunk_red))
                ),
                array('Total', toString(AVG(all_red)))
            )
        ) AS metrics
    FROM
        any_red
    GROUP BY
        granularity_bucket
),
avg_red AS (
    SELECT
        granularity_bucket,
        metrics[1] AS name,
        toFloat32(metrics[2]) AS metric
    FROM
        classified_red
    ORDER BY
        granularity_bucket DESC
)
SELECT
    granularity_bucket,
    name,
    -- 2 week rolling average
    (
        SUM(metric) OVER(
            PARTITION BY name
            ORDER BY
                granularity_bucket ROWS 1 PRECEDING
        )
    ) / 2.0 AS metric
FROM
    avg_red
