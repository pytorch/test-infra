WITH
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
            DATE_TRUNC('DAY', date) = DATE_TRUNC('DAY', PARSE_DATETIME_ISO8601(: queryDate))
            AND workflow_name =: workflow_name
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
        WHERE
            DATE_TRUNC('DAY', date) = DATE_TRUNC('DAY', PARSE_DATETIME_ISO8601(: queryDate))
        GROUP BY
            workflow_name,
            test_class,
            test_file,
            date,
            oncalls,
            config_job_name,
            config_shard_name
    ),
    filtered_with_costs AS (
        SELECT
            t.avg_duration_in_second as avg_duration_in_second,
            t.oncalls,
            t.date,
            t.workflow_name,
            t.test_class,
            t.test_file,
            t.workflow_occurences as workflow_occurences,
            t.config_job_name,
            t.config_shard_name,
            CASE
                WHEN p.price IS NULL THEN 0
                ELSE CAST(p.price AS float) * t.avg_duration_in_second / 60 / 60
            END as estimated_price
        FROM
            filtered_table as t
            LEFT JOIN commons.price_per_config p ON (
                t.config_job_name = p.job_name
                AND t.config_shard_name = p.shard_name
            )
    ),
    test_runs AS (
        SELECT
            count(*) as the_count,
            REPLACE(REPLACE(t2.oncall, 'module: ', ''), 'oncall: ', '') as oncall,
            t.workflow_name as workflow_type,
            -- summing over job name here as it contains information on each shard
            SUM(t.avg_duration_in_second) AS avg_duration_in_second,
            SUM(t.estimated_price) as estimated_price_per_run_in_dollars,
            t.date as granularity_bucket,
            t.test_class as test_class,
            t.test_file as test_file,
            t.workflow_occurences,
            t.config_job_name,
            t.config_shard_name
        FROM
            filtered_with_costs as t,
            UNNEST(t.oncalls AS oncall) AS t2
        WHERE
            REPLACE(REPLACE(t2.oncall, 'module: ', ''), 'oncall: ', '') =: oncall
        GROUP BY
            t2.oncall,
            t.config_job_name,
            t.config_shard_name,
            t.date,
            t.test_class,
            t.test_file,
            t.workflow_name,
            t.workflow_occurences
        ORDER BY
            avg_duration_in_second DESC
    ),
    test_runs_averaged as (
        SELECT
            oncall,
            workflow_type,
            granularity_bucket,
            test_class,
            test_file,
            TRUNC(
                SUM(
                    estimated_price_per_run_in_dollars * workflow_occurences
                ) / SUM(workflow_occurences),
                2
            ) as est_cost_per_run,
            TRUNC(
                SUM(
                    estimated_price_per_run_in_dollars * workflow_occurences
                ),
                2
            ) as est_cost_per_day,
            SUM(avg_duration_in_second) as avg_duration_in_second
        FROM
            test_runs
        GROUP BY
            oncall,
            workflow_type,
            granularity_bucket,
            test_class,
            test_file
    )
SELECT
    *,
FROM
    test_runs_averaged
WHERE
    avg_duration_in_second >=: thresholdInSecond
ORDER BY
    avg_duration_in_second DESC
