WITH aggregate_data AS (
    SELECT
    job_id,
    run_attempt,
    max(JSONExtractFloat(json_data, 'cpu','max')) as cpu_max,
    max(JSONExtractFloat(json_data, 'memory','max')) as memory_max,
    max(arrayMax(arrayMap(x->JSONExtractFloat(x,'util_percent','max'),JSONExtractArrayRaw(json_data,'gpu_usage')))) as gpu_max,
    max(arrayMax(arrayMap(x->JSONExtractFloat(x,'mem_util_percent','max'),JSONExtractArrayRaw(json_data,'gpu_usage')))) as gpu_mem_max,
    avg(JSONExtractFloat(json_data, 'cpu','max')) as cpu_avg,
    avg(JSONExtractFloat(json_data, 'memory','max')) as memory_avg,
    avg(arrayAvg(arrayMap(x->JSONExtractFloat(x,'util_percent','max'),JSONExtractArrayRaw(json_data,'gpu_usage')))) as gpu_avg,
    avg(arrayAvg(arrayMap(x->JSONExtractFloat(x,'mem_util_percent','max'),JSONExtractArrayRaw(json_data,'gpu_usage')))) as gpu_mem_avg,
    quantile(0.9)(JSONExtractFloat(json_data, 'cpu','max')) AS cpu_p90,
    quantile(0.9)(JSONExtractFloat(json_data, 'memory','max')) AS memory_p90,
    quantile(0.9)(arrayMax(arrayMap(x->JSONExtractFloat(x,'util_percent','max'),JSONExtractArrayRaw(json_data,'gpu_usage')))) as gpu_p90,
    quantile(0.9)(arrayMax(arrayMap(x->JSONExtractFloat(x,'mem_util_percent','max'),JSONExtractArrayRaw(json_data,'gpu_usage')))) as gpu_mem_p90
FROM
    misc.oss_ci_time_series
WHERE
    workflow_id={ workflowId: UInt64}
    AND repo = { repo: String }
    AND type = 'utilization'
GROUP BY
    job_id,
    run_attempt
)
SELECT
    o.workflow_id,
    o.job_id,
    o.run_attempt,
    o.workflow_name,
    o.job_name,
    o.run_attempt,
    o.repo,
    o.gpu_count,
    a.cpu_max,
    a.cpu_avg,
    a.memory_max,
    a.memory_avg,
    a.gpu_max,
    a.gpu_avg,
    a.gpu_mem_max,
    a.gpu_mem_avg,
    a.cpu_p90,
    a.memory_p90,
    a.gpu_mem_p90,
    a.gpu_p90
FROM
    misc.oss_ci_utilization_metadata o
    JOIN aggregate_data a ON a.job_id = o.job_id AND a.run_attempt = o.run_attempt
WHERE
    o.workflow_id = { workflowId: UInt64}
    AND o.repo = { repo: String }
