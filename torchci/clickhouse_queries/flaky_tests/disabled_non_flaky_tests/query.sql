-- This query is used in https://hud.pytorch.org/flakytest
WITH aggregated_weekly_data AS (
    SELECT
        name,
        classname,
        filename,
        SUM(
            CASE
                WHEN flaky THEN 1
                ELSE 0
            END
        ) > 0 AS flaky,
        SUM(num_green) AS num_green,
        SUM(num_red) as num_red
    FROM
        default .rerun_disabled_tests r
        LEFT JOIN default .workflow_run w FINAL ON r.workflow_id = w.id
    WHERE
        w.created_at > CURRENT_TIMESTAMP() - INTERVAL 7 DAY
    GROUP BY
        name,
        classname,
        filename
)
SELECT
    *
FROM
    aggregated_weekly_data
WHERE
    flaky = false
    -- The default values from Rockset is 150 for min_num_green and 0 for max_num_red
    AND num_green >= {min_num_green: Int64}
    AND num_red <= {max_num_red: Int64}
