WITH
    filtered_table AS (
        SELECT
            oncalls,
            workflow_name,
            CAST(workflow_id as STRING) as workflow_id,
            test_class,
            test_file,
        FROM
            metrics.aggregated_test_metrics
        WHERE
            workflow_run_attempt = 1
            AND workflow_id IS NOT NULL
            AND workflow_name = :workflow_name
            AND DATE_TRUNC('DAY', PARSE_DATETIME_ISO8601(date)) = DATE_TRUNC('DAY', CAST(PARSE_DATETIME_ISO8601(:queryDate) as date))
            AND test_class LIKE :classname
        GROUP BY
            workflow_name,
            test_class,
            test_file,
            workflow_id,
            date,
            oncalls
    ),
    filtered_oncalls as (
        SELECT
            f.test_class,
            f.test_file,
            oncall
        FROM
            (filtered_table f
            CROSS JOIN UNNEST(oncalls AS oncall))
        WHERE
            REPLACE(REPLACE(oncall, 'module: ', ''), 'oncall: ', '') LIKE: oncall
        GROUP BY
          f.test_class,
          f.test_file,
          oncall
    ),
    workflow_id_table as (
        SELECT
            workflow_id,
            workflow_name
        from
            filtered_table
        GROUP BY
            workflow_name,
            workflow_id
        LIMIT
          3
    ),
    test_times_filtered as (
        SELECT
            test_runs.time,
            test_runs.classname,
            test_runs.invoking_file,
            test_runs.name,
            wid.workflow_name,
        FROM
            commons.test_run_s3 test_runs
            INNER JOIN workflow_id_table wid ON (test_runs.workflow_id = wid.workflow_id) HINT(join_strategy = lookup)
        WHERE
          test_runs.workflow_run_attempt = 1
  ),
    test_times_with_oncalls as (
        SELECT
            time,
            classname,
            workflow_name,
            name,
            invoking_file,
            oncall
        FROM
            test_times_filtered test_runs
            INNER JOIN filtered_oncalls oncalls ON (test_runs.invoking_file = oncalls.test_file) HINT(join_strategy = lookup)
    )
SELECT
    AVG(time) as avg_time_in_seconds,
    classname as test_class,
    invoking_file as test_file,
    name as test_name,
    oncall,
    workflow_name
FROM
    test_times_with_oncalls
GROUP BY
    oncall,
    workflow_name,
    invoking_file,
    classname,
    name
HAVING
    AVG(time) >= :thresholdInSecond
ORDER BY
    avg_time_in_seconds DESC
