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
    {group_by:String} AS group_field,

    avgMerge(cpu_avg_state) AS cpu_avg,
    avgMerge(memory_avg_state) AS memory_avg,
    avgMerge(gpu_avg_state) AS gpu_avg,
    avgMerge(gpu_mem_state) AS gpu_mem_avg,

    map(
        'cpu_avg', avgMerge(cpu_avg_state),
        'memory_avg', avgMerge(memory_avg_state),
        'gpu_avg', avgMerge(gpu_avg_state),
        'gpu_mem_avg', avgMerge(gpu_mem_state),

        'cpu_p50',
        quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98) (cpu_p_state)[2],
        'cpu_p90',
        quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98) (cpu_p_state)[3],
        'cpu_p95',
        quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98) (cpu_p_state)[4],

        'memory_p50',
        quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98) (memory_p_state)[2],
        'memory_p90',
        quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98) (memory_p_state)[3],
        'memory_p95',
        quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98) (memory_p_state)[4],

        'gpu_p50',
        quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98) (gpu_p_state)[2],
        'gpu_p90',
        quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98) (gpu_p_state)[3],
        'gpu_p95',
        quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98) (gpu_p_state)[4],

        'gpu_mem_p50',
        quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98) (gpu_mem_p_state)[2],
        'gpu_mem_p90',
        quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98) (gpu_mem_p_state)[3],
        'gpu_mem_p95',
        quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98) (gpu_mem_p_state)[4],
        'gpu_mem_p98',
        quantilesTDigestMerge(0.1, 0.5, 0.9, 0.95, 0.98) (gpu_mem_p_state)[5]
    ) AS metrics

FROM fortesting.oss_ci_utilization_summary_report_v1

WHERE
    time >= toDate({start_time:String})
    AND time <= toDate({end_time:String})
    AND report_type = multiIf(
        {group_by:String} = 'job_name', 'daily_job',
        {group_by:String} = 'workflow_name', 'daily_workflow',
        'unknown'
    )
    AND (
        {parent_group:String} = '' OR parent_group = {parent_group:String}
    )
GROUP BY
    time_group,
    group_key,
    group_field,
    parent_group
ORDER BY
    time_group,
    group_key;
