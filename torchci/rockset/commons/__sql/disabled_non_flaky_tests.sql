WITH aggregated_weekly_data AS (
  SELECT
    name,
    classname,
    filename,
    SUM(CASE WHEN flaky THEN 1 ELSE 0 END) > 0 AS flaky,
    SUM(num_green) AS num_green,
    SUM(num_red) as num_red
  FROM
    commons.rerun_disabled_tests
  WHERE
    _event_time > CURRENT_TIMESTAMP() - INTERVAL 7 DAY
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
  AND num_green >= :min_num_green
  AND num_red <= :max_num_red
