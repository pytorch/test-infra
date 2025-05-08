CREATE MATERIALIZED VIEW oss_ci_utilization_summary_report_mv
TO oss_ci_utilization_summary_report
AS
SELECT
    js.job_start_day AS time,
    job_name,
    workflow_name,
    repo,
    count(DISTINCT job_id) AS job_run_counts,
    map(
        'cpu_avg', avg(JSONExtractFloat(json_data, 'cpu', 'max')),
        'memory_avg', avg(JSONExtractFloat(json_data, 'memory', 'max')),
        'gpu_avg', avg(arrayAvg(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))),
        'gpu_mem_avg', avg(arrayAvg(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))),
        'cpu_p50', quantile(0.5)(JSONExtractFloat(json_data, 'cpu', 'max')),
        'cpu_p90', quantile(0.9)(JSONExtractFloat(json_data, 'cpu', 'max')),
        'cpu_p95', quantile(0.95)(JSONExtractFloat(json_data, 'cpu', 'max')),

        'memory_p50', quantile(0.5)(JSONExtractFloat(json_data, 'memory', 'max')),
        'memory_p90', quantile(0.9)(JSONExtractFloat(json_data, 'memory', 'max')),
        'memory_p95', quantile(0.95)(JSONExtractFloat(json_data, 'memory', 'max')),

        'gpu_p50', quantile(0.5)(arrayMax(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))),
        'gpu_p90', quantile(0.9)(arrayMax(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))),
        'gpu_p95', quantile(0.95)(arrayMax(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))),

        'gpu_mem_p50', quantile(0.5)(arrayMax(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))),
        'gpu_mem_p90', quantile(0.9)(arrayMax(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))),
        'gpu_mem_p95', quantile(0.95)(arrayMax(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage'))))
    ) AS metrics,
    toUnixTimestamp(now()) AS version,
    'daily' AS report_type
FROM misc.oss_ci_time_series
INNER JOIN (
    SELECT
        job_id,
        toDate(min(time_stamp)) AS job_start_day
    FROM misc.oss_ci_time_series
    WHERE type = 'utilization'
    GROUP BY job_id
) js USING (job_id)
GROUP BY js.job_start_day, job_name, workflow_name, repo;



 -- Below is the SQL query to backfill the view with data to date '2025-05-07'(utc)
INSERT INTO oss_ci_utilization_summary_report
SELECT
    js.job_start_day AS time,
    job_name,
    workflow_name,
    repo,
    count(DISTINCT job_id) AS job_run_counts,
    map(
        'cpu_avg', avg(JSONExtractFloat(json_data, 'cpu', 'max')),
        'memory_avg', avg(JSONExtractFloat(json_data, 'memory', 'max')),
        'gpu_avg', avg(arrayAvg(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))),
        'gpu_mem_avg', avg(arrayAvg(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))),
        'cpu_p50', quantile(0.5)(JSONExtractFloat(json_data, 'cpu', 'max')),
        'cpu_p90', quantile(0.9)(JSONExtractFloat(json_data, 'cpu', 'max')),
        'cpu_p95', quantile(0.95)(JSONExtractFloat(json_data, 'cpu', 'max')),
        'memory_p50', quantile(0.5)(JSONExtractFloat(json_data, 'memory', 'max')),
        'memory_p90', quantile(0.9)(JSONExtractFloat(json_data, 'memory', 'max')),
        'memory_p95', quantile(0.95)(JSONExtractFloat(json_data, 'memory', 'max')),
        'gpu_p50', quantile(0.5)(arrayMax(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))),
        'gpu_p90', quantile(0.9)(arrayMax(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))),
        'gpu_p95', quantile(0.95)(arrayMax(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))),
        'gpu_mem_p50', quantile(0.5)(arrayMax(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))),
        'gpu_mem_p90', quantile(0.9)(arrayMax(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))),
        'gpu_mem_p95', quantile(0.95)(arrayMax(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage'))))
    ) AS metrics,
    toUnixTimestamp(now()) AS version,
    'daily' AS report_type
FROM misc.oss_ci_time_series
INNER JOIN (
    SELECT
        job_id,
        toDate(min(time_stamp)) AS job_start_day
    FROM misc.oss_ci_time_series
    WHERE type='utilization'
    GROUP BY job_id
) js USING (job_id)
WHERE js.job_start_day=toDate('2025-05-07')
GROUP BY js.job_start_day, job_name, workflow_name, repo;
