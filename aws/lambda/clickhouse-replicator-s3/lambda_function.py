from functools import lru_cache
import json
import os
from collections import defaultdict
from enum import Enum
from typing import Any, Dict, List, Optional
from warnings import warn
import clickhouse_connect
import urllib
import argparse

CLICKHOUSE_ENDPOINT = os.getenv("CLICKHOUSE_ENDPOINT", "")
CLICKHOUSE_USERNAME = os.getenv("CLICKHOUSE_USERNAME", "default")
CLICKHOUSE_PASSWORD = os.getenv("CLICKHOUSE_PASSWORD", "")


class EventType(Enum):
    PUT = "ObjectCreated"
    REMOVE = "ObjectRemoved"


@lru_cache(maxsize=1)
def get_clickhouse_client() -> Any:
    return clickhouse_connect.get_client(
        host=CLICKHOUSE_ENDPOINT,
        user=CLICKHOUSE_USERNAME,
        password=CLICKHOUSE_PASSWORD,
        secure=True,
    )


def lambda_handler(event: Any, context: Any) -> None:
    # https://clickhouse.com/docs/en/integrations/python
    counts = defaultdict(int)
    for record in event["Records"]:
        event_name = record.get("eventName", "")
        try:
            if event_name.startswith(EventType.PUT.value):
                upsert_document(record)
            elif event_name.startswith(EventType.REMOVE.value):
                remove_document(record)
            else:
                warn(f"Unrecognized event type {event_name} in {json.dumps(record)}")

            counts[event_name] += 1
        except Exception as error:
            warn(f"Failed to process {json.dumps(record)}: {error}")

    print(f"Finish processing {json.dumps(counts)}")


def encode_url_component(url):
    return urllib.parse.quote(url)


def handle_test_run_s3(table, bucket, key) -> List[Dict[str, Any]]:
    def clean_up_query(query):
        return " ".join([line.strip() for line in query.split("\n")])

    def get_sys_err_out_parser(name):
        # system-err and system-out generally have either the format:
        # Tuple(text String) or Array(Tuple(text String))
        # This function returns a query that will parse out the text field into an array of strings
        return f"""
        if(
            JSONArrayLength(`{name}`) is null,
            if(
                JSONHas(`{name}`, 'text'),
                array(JSONExtractString(`{name}`, 'text')),
                [ ]
            ),
            JSONExtractArrayRaw(JSON_QUERY(`{name}`, '$[*].text'))
        ) as `{name}`
        """

    def get_skipped_failure_parser_helper(name, type, field_to_check_for_existence):
        # skipped and failure generally have either the format:
        # Tuple(stuff) or Array(Tuple(stuff)).
        # The stuff varies. The type input should be the string `Tuple(stuff)`
        # The field_to_check_for_existence is the field that is checked to see
        # if the skip/rerun exists or if it should be an empty array.  It is a
        # dictionary key in the tuple
        return f"""
        if(
            JSONArrayLength({name}) is null,
            if(
                JSONHas({name}, '{field_to_check_for_existence}'),
                array(
                    JSONExtract(
                        {name},
                        '{type}'
                    )
                ),
                [ ]
            ),
            JSONExtract(
                {name},
                'Array({type})'
            )
        ) as {name}
        """

    # Cannot use general_adapter due to custom field for now()::DateTime64(9)
    # time_inserted
    query = f"""
    insert into {table}
    select
        classname,
        duration,
        {get_skipped_failure_parser_helper('error', 'Tuple(type String, message String, text String)', 'message')},
        {get_skipped_failure_parser_helper('failure', 'Tuple(type String, message String, text String)', 'message')},
        file,
        invoking_file,
        job_id,
        line::Int64,
        name,
        properties,
        {get_skipped_failure_parser_helper('rerun', 'Tuple(message String, text String)', 'message')},
        result,
        {get_skipped_failure_parser_helper('skipped', 'Tuple(type String, message String, text String)', 'message')},
        status,
        {get_sys_err_out_parser('system-err')},
        {get_sys_err_out_parser('system-out')},
        time,
        now()::DateTime64(9) as time_inserted,
        type_param,
        value_param,
        workflow_id,
        workflow_run_attempt,
        ('{bucket}', '{key}')
    from
        s3(
            'https://{bucket}.s3.amazonaws.com/{encode_url_component(key)}',
            'JSONEachRow',
            '
            `classname` String,
            `duration` Float32,
            `error` String,
            `failure` String,
            `file` String,
            `invoking_file` String,
            `job_id` Int64,
            `line` Float32,
            `name` String,
            `properties` Tuple(property Tuple(name String, value String)),
            `rerun` String,
            `result` String,
            `skipped` String,
            `status` String,
            `system-err` String,
            `system-out` String,
            `time` Float32,
            `type_param` String,
            `value_param` String,
            `workflow_id` Int64,
            `workflow_run_attempt` Int32',
            'gzip'
        )
    """
    query = clean_up_query(query)
    try:
        get_clickhouse_client().query(query)
    except Exception as e:
        log_failure_to_clickhouse(table, bucket, key, e)


def rerun_disabled_tests_adapter(table, bucket, key):
    schema = """
    `classname` String,
    `filename` String,
    `flaky` Bool,
    `name` String,
    `num_green` Int64,
    `num_red` Int64,
    `workflow_id` Int64,
    `workflow_run_attempt` Int64
    """

    general_adapter(table, bucket, key, schema, ["gzip"], "JSONEachRow")


def handle_test_run_summary(table, bucket, key) -> None:
    schema = """
    `classname` String,
    `errors` Int64,
    `failures` Int64,
    `file` String,
    `invoking_file` String,
    `job_id` Int64,
    `skipped` Int64,
    `successes` Int64,
    `tests` Int64,
    `time` Float32,
    `workflow_id` Int64,
    `workflow_run_attempt` Int64
    """
    url = f"https://{bucket}.s3.amazonaws.com/{encode_url_component(key)}"

    # Cannot use general_adapter due to custom field for now()::DateTime64(9)
    def get_insert_query(compression):
        return f"""
        insert into {table} SETTINGS async_insert=1, wait_for_async_insert=1
        select *, ('{bucket}', '{key}'), now()::DateTime64(9)
        from s3('{url}', 'JSONEachRow', '{schema}', '{compression}')
        """

    try:
        get_clickhouse_client().query(get_insert_query("gzip"))
    except Exception as e:
        log_failure_to_clickhouse(table, bucket, key, e)


def merges_adapter(table, bucket, key) -> None:
    schema = """
    `_id` String,
    `author` String,
    `broken_trunk_checks` Array(Array(String)),
    `comment_id` Int64,
    `dry_run` Bool,
    `error` String,
    `failed_checks` Array(Array(String)),
    `flaky_checks` Array(Array(String)),
    `ignore_current` Bool,
    `ignore_current_checks` Array(Array(String)),
    `is_failed` Bool,
    `last_commit_sha` String,
    `merge_base_sha` String,
    `merge_commit_sha` String,
    `owner` String,
    `pending_checks` Array(Array(String)),
    `pr_num` Int64,
    `project` String,
    `skip_mandatory_checks` Bool,
    `unstable_checks` Array(Array(String))
    """

    general_adapter(table, bucket, key, schema, ["none"], "JSONEachRow")


def merge_bases_adapter(table, bucket, key) -> None:
    schema = """
    `changed_files` Array(String),
    `merge_base` String,
    `merge_base_commit_date` DateTime64(3),
    `repo` String,
    `sha` String
    """

    general_adapter(table, bucket, key, schema, ["gzip", "none"], "JSONEachRow")


def queue_times_historical_adapter(table, bucket, key) -> None:
    schema = """
    `avg_queue_s` Int64,
    `machine_type` String,
    `count` Int64,
    `time` DateTime64(9)
    """
    general_adapter(table, bucket, key, schema, ["gzip", "none"], "JSONEachRow")


def external_contribution_stats_adapter(table, bucket, key) -> None:
    schema = """
    `date` String,
    `pr_count` Int64,
    `user_count` Int64,
    `users` Array(String)
    """
    general_adapter(table, bucket, key, schema, ["gzip"], "JSONEachRow")


def log_failure_to_clickhouse(table, bucket, key, error) -> None:
    error = {
        "table": table,
        "bucket": bucket,
        "key": key,
        "reason": str(error),
    }
    get_clickhouse_client().query(
        f"insert into errors.gen_errors format JSONEachRow {json.dumps(error)}"
    )


def general_adapter(table, bucket, key, schema, compressions, format) -> None:
    url = f"https://{bucket}.s3.amazonaws.com/{encode_url_component(key)}"

    def get_insert_query(compression):
        return f"""
        insert into {table}
        select *, ('{bucket}', '{key}') as _meta
        from s3('{url}', '{format}', '{schema}', '{compression}',
            extra_credentials(
                role_arn = 'arn:aws:iam::308535385114:role/clickhouse_role'
            )
        )
        """

    try:
        exceptions = []
        for compression in compressions:
            try:
                get_clickhouse_client().query(get_insert_query(compression))
                return
            except Exception as e:
                exceptions.append(e)
        raise Exception(
            f"Failed to insert into {table} with {[str(x) for x in exceptions]}"
        )
    except Exception as e:
        log_failure_to_clickhouse(table, bucket, key, e)


def external_aggregated_test_metrics_adapter(table, bucket, key) -> None:
    schema = """
    `avg_duration_in_second` Int64,
    `avg_skipped` Int64,
    `avg_tests` Int64,
    `base_name` String,
    `date` DateTime64(3),
    `job_name` String,
    `max_errors` Int64,
    `max_failures` Int64,
    `occurences` Int64,
    `oncalls` Array(String),
    `sum_duration_in_second` Int64,
    `sum_skipped` Int64,
    `sum_tests` Int64,
    `test_class` String,
    `test_config` String,
    `test_file` String,
    `workflow_id` Int64,
    `workflow_name` String,
    `workflow_run_attempt` Int64
    """
    general_adapter(table, bucket, key, schema, ["gzip"], "JSONEachRow")


def torchao_perf_stats_adapter(table, bucket, key) -> None:
    schema = """
    `CachingAutotuner.benchmark_all_configs` String,
    `GraphLowering.compile_to_module` String,
    `GraphLowering.run` String,
    `OutputGraph.call_user_compiler` String,
    `Scheduler.__init__` String,
    `Scheduler.codegen` String,
    `WrapperCodeGen.generate` String,
    `_compile.<locals>.compile_inner` String,
    `_compile.compile_inner` String,
    `abs_latency` String,
    `accuracy` String,
    `autograd_captures` String,
    `autograd_compiles` String,
    `batch_size` String,
    `calls_captured` String,
    `compilation_latency` String,
    `compile_fx.<locals>.bw_compiler` String,
    `compile_fx.<locals>.fw_compiler_base` String,
    `compile_fx_inner` String,
    `compression_ratio` String,
    `create_aot_dispatcher_function` String,
    `cudagraph_skips` String,
    `dev` String,
    `dynamo_peak_mem` String,
    `eager_peak_mem` String,
    `filename` String,
    `graph_breaks` String,
    `head_branch` String,
    `head_repo` String,
    `head_sha` String,
    `job_id` String,
    `name` String,
    `run_attempt` String,
    `runner` String,
    `speedup` String,
    `test_name` String,
    `unique_graph_breaks` String,
    `unique_graphs` String,
    `workflow_id` String
    """
    general_adapter(table, bucket, key, schema, ["none"], "CSV")


def oss_ci_benchmark_v3_adapter(table, bucket, key) -> None:
    schema = """
    `timestamp` UInt64,
    `schema_version` String,
    `name` String,
    `repo` String,
    `head_branch` String,
    `head_sha` String,
    `workflow_id` UInt64,
    `run_attempt` UInt32,
    `job_id` UInt64,
    `servicelab_experiment_id` UInt64,
    `servicelab_trial_id` UInt64,
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
    `benchmark` Tuple(
        name String,
        mode String,
        dtype String,
        extra_info Map(String, String)
    ),
    `model` Tuple (
        name String,
        type String,
        backend String,
        origins Array(String),
        extra_info Map(String, String)
    ),
    `inputs` Map(
        String,
        Tuple(dtype String, extra_info Map(String, String))
    ),
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
    `metric` Tuple(
        name String,
        benchmark_values Array(Float32),
        target_value Float32,
        extra_info Map(String, String)
    )
    """
    general_adapter(table, bucket, key, schema, ["gzip", "none"], "JSONEachRow")


def oss_ci_util_metadata_adapter(table, bucket, key):
    schema = """
        `created_at` DateTime64(0),
        `repo` String,
        `workflow_id` UInt64,
        `run_attempt` UInt32,
        `job_id` UInt64,
        `workflow_name` String,
        `job_name` String,
        `usage_collect_interval` Float32,
        `data_model_version` String,
        `gpu_count` UInt32,
        `cpu_count` UInt32,
        `gpu_type` String,
        `start_at` DateTime64(0),
        `end_at` DateTime64(0),
        `segments` Array(Tuple(
                `level` String,
                `name` String,
                `start_at` DateTime64(0),
                `end_at` DateTime64(0),
                `extra_info` Map(String, String)
                )),
        `tags` Array(String)
    """
    general_adapter(table, bucket, key, schema, ["gzip", "none"], "JSONEachRow")


def oss_ci_util_time_series_adapter(table, bucket, key):
    schema = """
        `created_at` DateTime64(0),
        `type` String,
        `tags` Array(String),
        `time_stamp` DateTime64(0),
        `repo` String,
        `workflow_id` UInt64,
        `run_attempt` UInt32,
        `job_id` UInt64,
        `workflow_name` String,
        `job_name` String,
        `json_data` String
     """
    general_adapter(table, bucket, key, schema, ["gzip", "none"], "JSONEachRow")


def torchbench_userbenchmark_adapter(table, bucket, key):
    schema = """
    `environ` String,
    `metrics` String,
    `name` String
    """

    general_adapter(table, bucket, key, schema, ["none"], "JSONEachRow")


def ossci_uploaded_metrics_adapter(table, bucket, key):
    schema = """
    `repo` String,
    `workflow` String,
    `build_environment` String,
    `job` String,
    `test_config` String,
    `pr_number` Int64,
    `run_id` Int64,
    `run_number` Int64,
    `run_attempt` Int64,
    `job_id` Int64,
    `job_name` String,
    `metric_name` String,
    `calling_file` String,
    `calling_module` String,
    `calling_function` String,
    `timestamp` DateTime64(9),
    `info` String
    """
    general_adapter(table, bucket, key, schema, ["gzip"], "JSONEachRow")


def stable_pushes_adapter(table, bucket, key):
    schema = """
    `sha` String,
    `repository` String,
    `timestamp` DateTime
    """
    general_adapter(table, bucket, key, schema, ["none"], "JSONEachRow")


SUPPORTED_PATHS = {
    "merges": "default.merges",
    "queue_times_historical": "default.queue_times_historical",
    "test_run": "default.test_run_s3",
    "test_run_summary": "default.test_run_summary",
    "merge_bases": "default.merge_bases",
    "failed_test_runs": "default.failed_test_runs",
    "rerun_disabled_tests": "default.rerun_disabled_tests",
    "external_contribution_counts": "misc.external_contribution_stats",
    "test_data_aggregates": "misc.aggregated_test_metrics",
    "torchbench-csv/torchao": "benchmark.inductor_torchao_perf_stats",
    "torchbench-userbenchmark": "benchmark.torchbench_userbenchmark",
    "ossci_uploaded_metrics": "misc.ossci_uploaded_metrics",
    "stable_pushes": "misc.stable_pushes",
    "v3": "benchmark.oss_ci_benchmark_v3",
    "debug_util_metadata": "fortesting.oss_ci_utilization_metadata",
    "debug_util_timeseries": "fortesting.oss_ci_time_series",
    "util_metadata":"misc.oss_ci_utilization_metadata",
    "util_timeseries":"misc.oss_ci_time_series",
}

OBJECT_CONVERTER = {
    "default.merges": merges_adapter,
    "default.test_run_s3": handle_test_run_s3,
    "default.failed_test_runs": handle_test_run_s3,
    "default.test_run_summary": handle_test_run_summary,
    "default.merge_bases": merge_bases_adapter,
    "default.rerun_disabled_tests": rerun_disabled_tests_adapter,
    "default.queue_times_historical": queue_times_historical_adapter,
    "misc.external_contribution_stats": external_contribution_stats_adapter,
    "misc.aggregated_test_metrics": external_aggregated_test_metrics_adapter,
    "benchmark.inductor_torchao_perf_stats": torchao_perf_stats_adapter,
    "benchmark.torchbench_userbenchmark": torchbench_userbenchmark_adapter,
    "misc.ossci_uploaded_metrics": ossci_uploaded_metrics_adapter,
    "misc.stable_pushes": stable_pushes_adapter,
    "benchmark.oss_ci_benchmark_v3": oss_ci_benchmark_v3_adapter,
    "fortesting.oss_ci_utilization_metadata": oss_ci_util_metadata_adapter,
    "fortesting.oss_ci_time_series": oss_ci_util_time_series_adapter,
    "misc.oss_ci_utilization_metadata": oss_ci_util_metadata_adapter,
    "misc.oss_ci_time_series": oss_ci_util_time_series_adapter,
}


def extract_clickhouse_table_name(bucket, key) -> Optional[str]:
    """
    Extract the clickhouse table name from the source ARN. This will be used later as
    the index name
    """
    if key is None:
        return None

    for path, table in SUPPORTED_PATHS.items():
        if key.startswith(f"{path}/"):
            return table

    return None


def extract_bucket(record: Any) -> Optional[str]:
    return record.get("s3", {}).get("bucket", {}).get("name", None)


def extract_key(record: Any) -> Optional[str]:
    return record.get("s3", {}).get("object", {}).get("key", None)


def upsert_document(record: Any) -> None:
    """
    Insert a new doc or modify an existing document. Note that ClickHouse doesn't really
    update the document in place, but rather adding a new record for the update
    """
    bucket, key = extract_bucket(record), extract_key(record)
    print(f"bucket: {bucket}, key: {key}")
    if not bucket or not key:
        return

    table = extract_clickhouse_table_name(bucket, key)
    if not table:
        return
    print(f"table: {table}")

    OBJECT_CONVERTER[table](table, bucket, key)


def remove_document(record: Any) -> None:
    """
    Remove a document. This is here for completeness as we don't remove records like ever
    """
    bucket, key = extract_bucket(record), extract_key(record)
    if not bucket or not key:
        return

    table = extract_clickhouse_table_name(bucket, key)
    if not table:
        return

    print(f"DELETING {key} FROM {table} (not implemented)")

    # parameters = {"id": key}
    # get_clickhouse_client().query(
    #     f"DELETE FROM `{table}` WHERE dynamoKey = %(id)s", parameters=parameters
    # )
