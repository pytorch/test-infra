DROP TABLE IF EXISTS oss_ci_utilization_summary_report_v1;

CREATE TABLE oss_ci_utilization_summary_report_v1 (
    time Date,
    group_key String,
    parent_group String,
    run_counts AggregateFunction(countDistinct, UInt64),
    ids AggregateFunction(groupArray, String),

    report_type String DEFAULT 'default',

    cpu_avg_state AggregateFunction(avg, Float64),
    memory_avg_state AggregateFunction(avg, Float64),
    gpu_avg_state AggregateFunction(avg, Float64),
    gpu_mem_state AggregateFunction(avg, Float64),

    cpu_p_state AggregateFunction(quantilesTDigest(0.1, 0.5, 0.9, 0.95, 0.98), Float64),
    memory_p_state AggregateFunction(quantilesTDigest(0.1, 0.5, 0.9, 0.95, 0.98), Float64),
    gpu_p_state AggregateFunction(quantilesTDigest(0.1, 0.5, 0.9, 0.95, 0.98), Float64),
    gpu_mem_p_state AggregateFunction(quantilesTDigest(0.1, 0.5, 0.9, 0.95, 0.98), Float64),

    extra_info Map(String, String),
    version UInt64 DEFAULT toUnixTimestamp(now())
) ENGINE = AggregatingMergeTree()
ORDER BY (report_type, time, group_key, parent_group);
