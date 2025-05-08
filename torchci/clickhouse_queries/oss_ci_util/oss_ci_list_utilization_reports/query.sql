SELECT
    multiIf(
        {granularity:String} = 'day', toDate(time),
        {granularity:String} = 'week', toStartOfWeek(time),
        {granularity:String} = 'month', toStartOfMonth(time),
        toDate(time)
    ) AS time_group,

    parent_group,
    countDistinctMerge(run_counts) AS total_runs,
    group_key,
    {groupBy:String} AS group_field,

    --
    avgMerge(cpu_avg_state) AS cpu_avg,
    avgMerge(memory_avg_state) AS memory_avg,
    avgMerge(gpu_avg_state) AS gpu_avg,
    avgMerge(gpu_mem_state) AS gpu_mem_avg,

    -- tdigestMerge percentile
    quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98)(cpu_p_state)[2] AS cpu_p50,
    quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98)(memory_p_state)[2] AS memory_p50,
    quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98)(gpu_p_state)[2] AS gpu_p50,
    quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98)(gpu_mem_p_state)[2] AS gpu_mem_p50,

    quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98)(cpu_p_state)[3] AS cpu_p90,
    quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98)(memory_p_state)[3] AS memory_p90,
    quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98)(gpu_p_state)[3] AS gpu_p90,
    quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98)(gpu_mem_p_state)[3] AS gpu_mem_p90,

    quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98)(cpu_p_state)[4] AS cpu_p95,
    quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98)(memory_p_state)[4] AS memory_p95,
    quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98)(gpu_p_state)[4] AS gpu_p95,
    quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98)(gpu_mem_p_state)[4] AS gpu_mem_p95,

    -- approxy max 98
    quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98)(gpu_p_state)[5] AS gpu_max

FROM fortesting.oss_ci_utilization_summary_report_v1

WHERE
    time >= toDate({startTime:String}) AND
    time <= toDate({endTime:String}) AND
    report_type = multiIf(
        {groupBy:String} = 'job_name', 'daily_job',
        {groupBy:String} = 'workflow_name', 'daily_workflow',
        'unknown'
    )

GROUP BY
    time_group,
    group_key,
    group_field,
    parent_group
ORDER BY
    time_group,
    group_key;
