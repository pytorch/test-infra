With
    workflow_summed_table AS (
        SELECT
            workflow_id,
            -- sum by job name to get total over all shards
            SUM(sum_duration_in_second) as sum_duration_in_second,
            oncalls,
            date,
            workflow_name
        FROM
            metrics.aggregated_test_metrics_with_preproc
        WHERE
            DATE_TRUNC('DAY', date) >= DATE_TRUNC('DAY', PARSE_DATETIME_ISO8601(: startDate))
            AND DATE_TRUNC('DAY', date) < DATE_TRUNC('DAY', PARSE_DATETIME_ISO8601(: endDate))
            AND workflow_name LIKE: workflow_type
        GROUP BY
            workflow_id,
            workflow_name,
            date,
            oncalls
    ),
    filtered_table AS (
        SELECT
            AVG(sum_duration_in_second) as avg_duration_in_second,
            oncalls,
            date,
            workflow_name,
        FROM
            workflow_summed_table
        GROUP BY
            workflow_name,
            date,
            oncalls
    ),
    filtered_with_oncalls as (
        SELECT
            *
        FROM
            (
                filtered_table
                CROSS JOIN UNNEST(oncalls AS oncall)
            )
        WHERE
            REPLACE(REPLACE(oncall, 'module: ', ''), 'oncall: ', '') LIKE: oncall
    ),
    t as (
        SELECT
            avg_duration_in_second as time_in_seconds,
            REPLACE(REPLACE(oncall, 'module: ', ''), 'oncall: ', '') as oncall,
            CAST(filtered_with_oncalls.date AS STRING) as granularity_bucket,
            filtered_with_oncalls.workflow_name as workflow_name,
        FROM
            filtered_with_oncalls
    )
SELECT
    *,
FROM
    t
ORDER BY
    time_in_seconds DESC
