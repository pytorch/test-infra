-- This query creates the oss_ci_benchmark_v3 table on ClickHouse
CREATE TABLE benchmark.oss_ci_benchmark_v3 (
    -- Metadata
    `timestamp` UInt64,
    `schema_version` String DEFAULT 'v3',
    `name` String,
    -- About the change
    `repo` String DEFAULT 'pytorch/pytorch',
    `head_branch` String,
    `head_sha` String,
    `workflow_id` UInt64,
    `run_attempt` UInt32,
    `job_id` UInt64,
    -- (optional) Service Lab id if the result comes from there
    `servicelab_experiment_id` UInt64 DEFAULT '0',
    `servicelab_trial_id` UInt64 DEFAULT '0',
    -- The raw records on S3, this is populated by the replicator
    `_meta` Tuple(bucket String, key String),
    -- About the devices where the benchmark runs. There could be more than one
    -- runner (distributed benchmark)
    --  name, the optional name of the runner
    --  type, the runner type or label, i.e. linux.aws.a100, or android S22
    --  cpu_info, i.e. x86_64 or arm
    --  cpu_count, the number of CPU cores
    --  mem_info, TBD
    --  avail_mem_in_gb, the amount of available memory (GB)
    --  gpu_info, i.e. NVIDIA A100 or mps
    --  gpu_count, the number of GPU devices
    --  gpu_mem_info, TBD
    --  avail_gpu_mem_in_gb, the total amount of available GPU memory (GB)
    --  extra_info, any extra piece of information in key/value format
    `runners` Array(
        Tuple(
            name String,
            type String,
            cpu_info String,
            cpu_count UInt32,
            mem_info String,
            avail_mem_in_gb UInt32,
            gpu_info String,
            gpu_count UInt32,
            gpu_mem_info String,
            avail_gpu_mem_in_gb UInt32,
            extra_info Map(String, String)
        )
    ),
    -- About the benchmark
    --   name, the name of the benchmark, i.e. cudagraphs
    --   mode, training or inference
    --   dtype, the quantization / dtype used by the benchmark
    `benchmark` Tuple(
        name String,
        mode String,
        dtype String,
        extra_info Map(String, String)
    ),
    -- About the model
    --  name, the model name
    --  type, open field, this could be a model, a custom layer, or a fused ops
    --  backend, the optional name of any delegation backend used by the model, i.e. XNNPACK
    --  origins, where it comes from, i.e. TorchBench. A model could be in multiple sources
    --  extra_info, any extra piece of information in key/value format
    `model` Tuple (
        name String,
        type String,
        backend String,
        origins Array(String),
        extra_info Map(String, String)
    ),
    -- About the inputs of the benchmark. Use a map keyed by input name here as there could
    -- be more than one
    `inputs` Map(
        String,
        Tuple(dtype String, extra_info Map(String, String))
    ),
    -- About important dependencies used by the benchmark, obviously there can be more than
    -- one, i.e. HF
    `dependencies` Map(
        String,
        Tuple(
            `repo` String,
            `branch` String,
            `sha` String,
            `version` String,
            extra_info Map(String, String)
        )
    ),
    -- About the metric
    --  name, the metric name
    --  benchmark_values, the benchmark values, using a list here to cover the case where there are multple runs
    `metric` Tuple(
        name String,
        benchmark_values Array(Float32),
        target_value Float32,
        extra_info Map(String, String)
    ),
) ENGINE = MergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY
    (
        timestamp,
        head_branch,
        head_sha,
        workflow_id,
        job_id,
        servicelab_experiment_id,
        servicelab_trial_id
    ) SETTINGS index_granularity = 8192
