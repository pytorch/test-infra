-- This query is used to show failures chart on https://hud.pytorch.org/reliability/pytorch/pytorch
WITH all_jobs AS (
    SELECT
        p.head_commit. 'timestamp' AS time,
        j.conclusion AS conclusion,
        p.head_commit. 'id' AS sha,
        CONCAT(
            w.name,
            ' / ',
            arrayElement(splitByString(' / ', j.name), 1),
            ' / ',
            arrayElement(
                splitByString(', ', arrayElement(splitByString(' / ', j.name), 2)),
                1
            )
        ) AS name
    FROM
        default .workflow_job j FINAL
        JOIN default .workflow_run w FINAL ON w.id = j.run_id
        JOIN default .push p FINAL on w.head_commit. 'id' = p.head_commit. 'id'
    WHERE
        j.name != 'ciflow_should_run'
        AND j.name != 'generate-test-matrix'
        AND j.name NOT LIKE '%rerun_disabled_tests%'
        AND j.name NOT LIKE '%filter%'
        AND j.name NOT LIKE '%unstable%'
        AND j.name LIKE '%/%'
        AND has({workflowNames: Array(String) }, lower(w.name))
        AND w.event != 'workflow_run' -- Filter out worflow_run-triggered jobs, which have nothing to do with the SHA
        AND p.ref = 'refs/heads/main'
        AND p.repository. 'owner'.'name' = 'pytorch'
        AND p.repository. 'name' = {repo: String}
        AND p.head_commit. 'timestamp' >= {startTime: DateTime64(3) }
        AND p.head_commit. 'timestamp' < {stopTime: DateTime64(3) }
),
reds AS(
    SELECT
        time,
        sha,
        IF (
            name LIKE '%(%'
            AND name NOT LIKE '%)%',
            CONCAT(name, ')'),
            name
        ) AS name,
        CAST(
            SUM(
                CASE
                    WHEN conclusion = 'failure' THEN 1
                    WHEN conclusion = 'timed_out' THEN 1
                    WHEN conclusion = 'cancelled' THEN 1
                    ELSE 0
                END
            ) > 0 AS int
        ) AS any_red,
        COUNT(*) AS c
    FROM
        all_jobs
    GROUP BY
        time,
        sha,
        name
    HAVING
        COUNT(*) >= 1 -- Filter out jobs that didn't run anything.
        AND SUM(IF(conclusion IS NULL, 1, 0)) = 0 -- Filter out commits that still have pending jobs.
    ORDER BY
        time DESC
),
reds_percentage AS (
    SELECT
        formatDateTime(DATE_TRUNC({granularity: String }, time), '%Y-%m-%d') AS granularity_bucket,
        name,
        ROUND(AVG(any_red) * 100, 2) AS red
    FROM
        reds
    GROUP BY
        granularity_bucket,
        name
)
SELECT
    *
FROM
    reds_percentage
WHERE
    red > 0
ORDER BY
    name ASC
