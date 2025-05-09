CREATE MATERIALIZED VIEW oss_ci_utilization_workflow_report_mv
TO oss_ci_utilization_summary_report_v1
AS
SELECT
    js.job_start_day AS time,
    workflow_name AS group_key,
    repo AS parent_group,
    countDistinctState(workflow_id) AS run_counts,
    groupArrayState(DISTINCT toString(workflow_id)) AS ids,
    'daily_workflow' AS report_type,

    -- avg states
    avgState(JSONExtractFloat(json_data, 'cpu', 'max')) AS cpu_avg_state,
    avgState(JSONExtractFloat(json_data, 'memory', 'max')) AS memory_avg_state,
    avgState(arrayAvg(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))) AS gpu_avg_state,
    avgState(arrayAvg(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))) AS gpu_mem_state,

    -- tdigest percentile states
    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(JSONExtractFloat(json_data, 'cpu', 'max')) AS cpu_p_state,
    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(JSONExtractFloat(json_data, 'memory', 'max')) AS memory_p_state,
    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(
        arrayMax(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))
    ) AS gpu_p_state,
    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(
        arrayMax(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))
    ) AS gpu_mem_p_state,

    map('repo', repo) AS extra_info,
    toUnixTimestamp(now()) AS version

FROM misc.oss_ci_time_series
INNER JOIN (
    SELECT
        job_id,
        toDate(min(time_stamp)) AS job_start_day
    FROM misc.oss_ci_time_series
    WHERE type = 'utilization'
    GROUP BY job_id
) js USING (job_id)
GROUP BY js.job_start_day, workflow_name, repo;


 -- Below is the SQL query to backfill the view with data to date '2025-05-07'(utc)
INSERT INTO oss_ci_utilization_summary_report_v1
SELECT
    js.job_start_day AS time,
    workflow_name AS group_key,
    repo AS parent_group,
    countDistinctState(workflow_id) AS run_counts,
    groupArrayState(DISTINCT toString(workflow_id)) AS ids,
    'daily_workflow' AS report_type,

    -- avg states
    avgState(JSONExtractFloat(json_data, 'cpu', 'max')) AS cpu_avg_state,
    avgState(JSONExtractFloat(json_data, 'memory', 'max')) AS memory_avg_state,
    avgState(arrayAvg(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))) AS gpu_avg_state,
    avgState(arrayAvg(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))) AS gpu_mem_state,

    -- tdigest percentile states
    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(JSONExtractFloat(json_data, 'cpu', 'max')) AS cpu_p_state,
    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(JSONExtractFloat(json_data, 'memory', 'max')) AS memory_p_state,
    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(
        arrayMax(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))
    ) AS gpu_p_state,
    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(
        arrayMax(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(json_data, 'gpu_usage')))
    ) AS gpu_mem_p_state,

    map('repo', repo) AS extra_info,
    toUnixTimestamp(now()) AS version
FROM misc.oss_ci_time_series
INNER JOIN (
    SELECT
        job_id,
        toDate(min(time_stamp)) AS job_start_day
    FROM misc.oss_ci_time_series
    WHERE type='utilization'
    GROUP BY job_id
) js USING (job_id)
WHERE js.job_start_day
-- BETWEEN toDate('2025-05-05') AND toDate('2025-05-07')
GROUP BY js.job_start_day, workflow_name, repo;
