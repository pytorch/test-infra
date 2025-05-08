SELECT
    multiIf(
        {granularity:String} = 'day', toDate(time),
        {granularity:String} = 'week', toStartOfWeek(time),
        {granularity:String} = 'month', toStartOfMonth(time),
        toDate(time)  -- default fallback
    ) AS time_group,
    sum(job_run_counts) as total_job_runs,
    multiIf(
    {groupBy:String} = 'job_name', job_name,
    {groupBy:String} = 'workflow_name', workflow_name,
    {groupBy:String} = 'workflow_name/job_name', concat(workflow_name, '|', job_name),
    {groupBy:String} = 'repo/workflow_name/job_name', concat(repo,'|',workflow_name, '|', job_name),
    {groupBy:String} = 'repo/workflow_name', concat(repo,'|',workflow_name),
    {groupBy:String} = 'repo', repo,
    workflow_name
    ) AS group_name,
    {groupBy:String} AS group_field,
    avg(metrics['cpu_avg']) as cpu_avg,
    avg(metrics['memory_avg']) as memory_avg,
    avg(metrics['gpu_avg']) as gpu_avg,
    avg(metrics['gpu_mem_avg']) as gpu_mem_avg,
    sum(metrics['cpu_p90'] * job_run_counts) / sum(job_run_counts) as cpu_p90,
    sum(metrics['gpu_p90'] * job_run_counts) / sum(job_run_counts) as gpu_p90,
    sum(metrics['gpu_mem_p90'] * job_run_counts) / sum(job_run_counts) as gpu_mem_p90,
    sum(metrics['cpu_p95'] * job_run_counts) / sum(job_run_counts) as cpu_p95,
    sum(metrics['gpu_p95'] * job_run_counts) / sum(job_run_counts) as gpu_p95,
    sum(metrics['gpu_mem_p95'] * job_run_counts) / sum(job_run_counts) as gpu_mem_p95
FROM
    fortesting.oss_ci_utilization_summary_report
WHERE time >= toDate({startTime:String}) AND time<=toDate({endTime:String})
GROUP BY
    group_name,
    time_group
ORDER BY time_group,group_name
