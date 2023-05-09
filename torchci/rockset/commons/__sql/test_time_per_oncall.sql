With
    workflow_summed_table AS (
        SELECT
            workflow_id,
            -- sum by job name to get total over all shards
            SUM(sum_duration_in_second) as sum_duration_in_second,
            oncalls,
            date,
            workflow_name,
            test_class,
            test_file,
            config_job_name,
            config_shard_name,
        FROM
            metrics.aggregated_test_metrics_with_preproc
        WHERE
            DATE_TRUNC('DAY', date) >= DATE_TRUNC('DAY', PARSE_DATETIME_ISO8601(: startDate))
            AND DATE_TRUNC('DAY', date) < DATE_TRUNC('DAY', PARSE_DATETIME_ISO8601(: endDate))
            AND workflow_name =: workflow_type
        GROUP BY
            workflow_id,
            workflow_name,
            test_class,
            test_file,
            date,
            oncalls,
            config_job_name,
            config_shard_name
    ),
    filtered_table AS (
        SELECT
            AVG(sum_duration_in_second) as avg_duration_in_second,
            COUNT(DISTINCT(workflow_id)) as workflow_occurences,
            oncalls,
            date,
            workflow_name,
            test_class,
            test_file,
            config_job_name,
            config_shard_name,
        FROM
            workflow_summed_table
        GROUP BY
            workflow_name,
            test_class,
            test_file,
            date,
            oncalls,
            config_job_name,
            config_shard_name
    ),
    filtered_with_costs as (
        SELECT
            t.avg_duration_in_second as avg_duration_in_second,
            t.oncalls as oncalls,
            t.date as date,
            t.workflow_name as workflow_name,
            t.test_class as test_class,
            t.test_file as test_file,
            t.config_job_name as config_job_name,
            t.config_shard_name as config_shard_name,
            t.workflow_occurences,
            CASE
                WHEN p.price IS NULL THEN 0
                ELSE CAST(p.price AS float)
            END as price_per_hour
        FROM
            filtered_table t
            LEFT JOIN commons.price_per_config p ON (
                t.config_job_name = p.job_name
                AND t.config_shard_name = p.shard_name
            )
    ),
    total_table as (
        SELECT
            date,
            workflow_name,
            SUM(avg_duration_in_second) as total_duration_per_workflow_per_run,
            SUM(price_per_hour * avg_duration_in_second / 60 / 60) as total_price_per_workflow_per_run
        FROM
            filtered_with_costs
        GROUP BY
            date,
            workflow_name
    ),
    filtered_with_oncalls as (
        SELECT
            *
        FROM
            (
                filtered_with_costs
                CROSS JOIN UNNEST(oncalls AS oncall)
            )
        WHERE
            REPLACE(REPLACE(oncall, 'module: ', ''), 'oncall: ', '') LIKE: oncall
    ),
    filtered_with_oncalls_and_totals as (
        SELECT
            avg_duration_in_second,
            REPLACE(REPLACE(oncall, 'module: ', ''), 'oncall: ', '') as oncall,
            filtered_with_oncalls.date as date,
            filtered_with_oncalls.workflow_name as workflow_name,
            test_class,
            test_file,
            total_duration_per_workflow_per_run,
            total_price_per_workflow_per_run,
            workflow_occurences,
            price_per_hour,
        FROM
            filtered_with_oncalls
            INNER JOIN total_table ON filtered_with_oncalls.date = total_table.date
            AND filtered_with_oncalls.workflow_name = total_table.workflow_name
        WHERE
            REPLACE(REPLACE(oncall, 'module: ', ''), 'oncall: ', '') LIKE: oncall
    ),
    t as (
        SELECT
            oncall,
            workflow_name as workflow_type,
            SUM(avg_duration_in_second) as time_in_seconds,
            TRUNC(
                SUM(price_per_hour * avg_duration_in_second / 60 / 60),
                2
            ) as estimated_price_per_run_in_dollars,
            TRUNC(
                SUM(
                    price_per_hour * avg_duration_in_second * workflow_occurences / 60 / 60
                ),
                2
            ) as estimated_price_per_day_in_dollars,
            CAST(date as STRING) as granularity_bucket,
            TRUNC(
                SUM(avg_duration_in_second) / ARBITRARY(
                    -- add noise to avoid divide by 0
                    total_duration_per_workflow_per_run + 0.000001
                ) * 100,
                2
            ) as percentage_of_time,
            TRUNC(
                SUM(price_per_hour * avg_duration_in_second / 60 / 60) / ARBITRARY(
                    -- add noise to avoid divide by 0
                    total_price_per_workflow_per_run + 0.000001
                ) * 100,
                2
            ) as percentage_of_cost,
        FROM
            filtered_with_oncalls_and_totals as t
        GROUP BY
            t.oncall,
            t.date,
            t.workflow_name
    )
SELECT
    *,
FROM
    t
ORDER BY
    time_in_seconds DESC
