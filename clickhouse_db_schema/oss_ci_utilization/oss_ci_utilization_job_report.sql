CREATE TABLE oss_ci_utilization_summary_report
(
    time Date,
    job_name String,
    workflow_name String,
    repo String,
    job_run_counts UInt64,
    metrics Map(String, Float64),
    version UInt64 DEFAULT toUnixTimestamp(now()),
    report_type String DEFAULT 'default'
) ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', version)
ORDER BY (repo, type, time, workflow_name, job_name)
