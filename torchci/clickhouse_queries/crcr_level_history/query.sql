-- The level is stamped on every dispatched CRCR job. Collapse jobs from the
-- same workflow run before looking for a change, so a matrix fan-out remains
-- one observed level transition.
WITH runs AS (
    SELECT
        min(started_at) AS observed_at,
        argMax(downstream_repo_level, started_at) AS new_level
    FROM default.crcr_workflow_job FINAL
    WHERE
        downstream_repo = {repo: String}
        AND started_at > 0
    GROUP BY run_id
),

observed_changes AS (
    SELECT
        observed_at AS changed_at,
        lagInFrame(new_level, 1, '') OVER (
            ORDER BY observed_at ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS previous_level,
        new_level
    FROM runs
),

recent_changes AS (
    SELECT
        changed_at,
        previous_level,
        new_level
    FROM observed_changes
    WHERE
        previous_level != ''
        AND previous_level != new_level
    ORDER BY changed_at DESC
    LIMIT {limit: UInt32}
)

SELECT
    changed_at,
    previous_level,
    new_level
FROM recent_changes
ORDER BY changed_at ASC
