CREATE MATERIALIZED VIEW oss_ci_utilization_job_report_mv

TO oss_ci_utilization_summary_report_v1 AS
SELECT
    js.job_start_day AS time,
    t.job_name AS group_key,
    concat(t.repo, '|', t.workflow_name) AS parent_group,
    countDistinctState(t.job_id) AS run_counts,
    groupArrayState(DISTINCT toString(t.job_id)) AS ids,
    'daily_job' AS report_type,

    avgState(JSONExtractFloat(t.json_data, 'cpu', 'max')) AS cpu_avg_state,
    avgState(JSONExtractFloat(t.json_data, 'memory', 'max')) AS memory_avg_state,
    avgState(arrayAvg(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(t.json_data, 'gpu_usage')))) AS gpu_avg_state,
    avgState(arrayAvg(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(t.json_data, 'gpu_usage')))) AS gpu_mem_state,

    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(JSONExtractFloat(t.json_data, 'cpu', 'max')) AS cpu_p_state,
    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(JSONExtractFloat(t.json_data, 'memory', 'max')) AS memory_p_state,
    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(
        arrayMax(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(t.json_data, 'gpu_usage')))
    ) AS gpu_p_state,
    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(
        arrayMax(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(t.json_data, 'gpu_usage')))
    ) AS gpu_mem_p_state,
    map(
        'workflow_name', t.workflow_name,
        'repo', t.repo
    ) AS extra_info,
    toUnixTimestamp(now()) AS version
FROM misc.oss_ci_time_series t
INNER JOIN (
    SELECT
        job_id,
        toDate(min(time_stamp)) AS job_start_day
    FROM misc.oss_ci_time_series
    WHERE type = 'utilization'
    GROUP BY job_id
) js USING (job_id)
WHERE t.type = 'utilization'
GROUP BY js.job_start_day, t.job_name, t.  workflow_name, t.repo;

 -- Below is the SQL query to backfill the view with data to date '2025-05-07'(utc)
INSERT INTO oss_ci_utilization_summary_report_v1
SELECT
    js.job_start_day AS time,
    t.job_name AS group_key,
    concat(t.repo, '|', t.workflow_name) AS parent_group,
    countDistinctState(t.job_id) AS run_counts,
    groupArrayState(DISTINCT toString(t.job_id)) AS ids,
    'daily_job' AS report_type,

    avgState(JSONExtractFloat(t.json_data, 'cpu', 'max')) AS cpu_avg_state,
    avgState(JSONExtractFloat(t.json_data, 'memory', 'max')) AS memory_avg_state,
    avgState(arrayAvg(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(t.json_data, 'gpu_usage')))) AS gpu_avg_state,
    avgState(arrayAvg(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(t.json_data, 'gpu_usage')))) AS gpu_mem_state,

    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(JSONExtractFloat(t.json_data, 'cpu', 'max')) AS cpu_p_state,
    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(JSONExtractFloat(t.json_data, 'memory', 'max')) AS memory_p_state,
    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(
        arrayMax(arrayMap(x -> JSONExtractFloat(x, 'util_percent', 'max'), JSONExtractArrayRaw(t.json_data, 'gpu_usage')))
    ) AS gpu_p_state,
    quantilesTDigestState(0.1, 0.5, 0.9, 0.95, 0.98)(
        arrayMax(arrayMap(x -> JSONExtractFloat(x, 'mem_util_percent', 'max'), JSONExtractArrayRaw(t.json_data, 'gpu_usage')))
    ) AS gpu_mem_p_state,
    map(
        'workflow_name', t.workflow_name,
        'repo', t.repo
    ) AS extra_info,
    toUnixTimestamp(now()) AS version
FROM misc.oss_ci_time_series AS t
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
GROUP BY js.job_start_day, job_name, workflow_name, repo;
