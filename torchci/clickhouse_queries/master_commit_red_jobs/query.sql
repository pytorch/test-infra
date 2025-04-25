-- This query is used to show failures on https://hud.pytorch.org/reliability/pytorch/pytorch
WITH all_jobs AS (
    SELECT
        p.head_commit. 'timestamp' AS time,
        j.conclusion AS conclusion,
        j.head_sha AS sha,
        p.head_commit. 'author'.'username' AS author,
        CONCAT(
                j.workflow_name,
                ' / ',
                arrayElement(splitByString(' / ', j.name), 1),
                ' / ',
                arrayElement(
                        splitByString(', ', arrayElement(splitByString(' / ', j.name), 2)),
                        1
                )
        ) AS name,
        (
            CASE
                WHEN p.head_commit. 'author'.'username' = 'pytorchmergebot' THEN p.head_commit. 'message'
                ELSE ''
                END
            ) AS body
    FROM
        default .workflow_job j FINAL
            JOIN default .push p FINAL on j.head_sha = p.head_commit. 'id'
    WHERE
        j.id in (
            SELECT id FROM materialized_views.workflow_job_by_head_sha
            WHERE head_sha in (SELECT distinct  p.head_commit. 'id'
                               FROM default.push p
                               WHERE
                                   p.ref = 'refs/heads/main'
                                 AND p.repository. 'owner'.'name' = 'pytorch'
                                 AND p.repository. 'name' = 'pytorch'
                                 AND p.head_commit. 'timestamp' >= {startTime: DateTime64(3) }
                                 AND p.head_commit. 'timestamp' < {stopTime: DateTime64(3) }
            )
        )
      AND j.name != 'ciflow_should_run'
      AND j.name != 'generate-test-matrix'
      AND j.name NOT LIKE '%rerun_disabled_tests%'
      AND j.name NOT LIKE '%filter%'
      AND j.name NOT LIKE '%unstable%'
      AND j.name LIKE '%/%'
      AND has({workflowNames: Array(String) }, lower(j.workflow_name))
      AND j.workflow_event != 'workflow_run' -- Filter out worflow_run-triggered jobs, which have nothing to do with the SHA
      AND p.ref = 'refs/heads/main'
      AND p.repository. 'owner'.'name' = 'pytorch'
      AND p.repository. 'name' = 'pytorch'
      AND p.head_commit. 'timestamp' >= {startTime: DateTime64(3) }
      AND p.head_commit. 'timestamp' < {stopTime: DateTime64(3) }

),
filtered_jobs AS (
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
        author,
        body
    FROM
        all_jobs
    GROUP BY
        time,
        sha,
        name,
        author,
        body
    HAVING
        COUNT(*) >= 1 -- Filter out jobs that didn't run anything.
        AND SUM(IF(conclusion IS NULL, 1, 0)) = 0 -- Filter out commits that still have pending jobs.
),
reds AS (
    SELECT
        time,
        sha,
        arrayFilter(x -> x != '', groupArray(IF (any_red > 0, name, ''))) AS failures,
        arrayFilter(x -> x != '', groupArray(IF (any_red = 0, name, ''))) AS successes,
        author,
        body
    FROM
        filtered_jobs
    GROUP BY
        time,
        sha,
        author,
        body
)
SELECT
    time,
    sha,
    author,
    body,
    failures,
    successes
FROM
    reds
ORDER BY
    time DESC
