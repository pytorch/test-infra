from functools import lru_cache
import json
import os
from collections import defaultdict
from enum import Enum
from typing import Any, Dict, List, Optional
from warnings import warn
import clickhouse_connect
import urllib

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
        if "Expected not greater than" in str(e):
            get_clickhouse_client().query(
                f"insert into errors.{table}_ingest_errors values ('{key}', 'file is too large?')"
            )
        else:
            get_clickhouse_client().query(
                f"insert into errors.{table}_ingest_errors values ('{key}', '{json.dumps(str(e))}')"
            )


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

    url = f"https://{bucket}.s3.amazonaws.com/{encode_url_component(key)}"

    def get_insert_query(compression):
        return f"""
        insert into {table}
        select *, ('{bucket}', '{key}')
        from s3('{url}', 'JSONEachRow', '{schema}', '{compression}')
        """

    try:
        get_clickhouse_client().query(get_insert_query("gzip"))
    except Exception as e:
        if "Expected not greater than" in str(e):
            get_clickhouse_client().query(
                f"insert into errors.{table}_ingest_errors values ('{key}', 'file is too large?')"
            )
        else:
            get_clickhouse_client().query(
                f"insert into errors.{table}_ingest_errors values ('{key}', '{json.dumps(str(e))}')"
            )


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

    def get_insert_query(compression):
        return f"""
        insert into {table} SETTINGS async_insert=1, wait_for_async_insert=1
        select *, ('{bucket}', '{key}'), now()::DateTime64(9)
        from s3('{url}', 'JSONEachRow', '{schema}', '{compression}')
        """

    try:
        get_clickhouse_client().query(get_insert_query("gzip"))
    except Exception as e:
        if "Expected not greater than" in str(e):
            get_clickhouse_client().query(
                f"insert into errors.{table}_ingest_errors values ('{key}', 'file is too large?')"
            )
        else:
            get_clickhouse_client().query(
                f"insert into errors.{table}_ingest_errors values ('{key}', '{json.dumps(str(e))}')"
            )


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

    url = f"https://{bucket}.s3.amazonaws.com/{encode_url_component(key)}"

    def get_insert_query(compression):
        return f"""
        insert into {table}
        select *, ('{bucket}', '{key}')
        from s3('{url}', 'JSONEachRow', '{schema}', '{compression}')
        """

    try:
        get_clickhouse_client().query(get_insert_query("none"))
    except Exception as e:
        get_clickhouse_client().query(
            f"insert into errors.{table}_ingest_errors values ('{key}', '{json.dumps(str(e))}')"
        )


def merge_bases_adapter(table, bucket, key) -> None:
    schema = """
    `changed_files` Array(String),
    `merge_base` String,
    `merge_base_commit_date` DateTime64(3),
    `repo` String,
    `sha` String
    """

    url = f"https://{bucket}.s3.amazonaws.com/{encode_url_component(key)}"

    def get_insert_query(compression):
        return f"""
        insert into {table}
        select *, ('{bucket}', '{key}')
        from s3('{url}', 'JSONEachRow', '{schema}', '{compression}')
        """

    try:
        get_clickhouse_client().query(get_insert_query("gzip"))
    except:
        get_clickhouse_client().query(get_insert_query("none"))


def queue_times_historical_adapter(table, bucket, key) -> None:
    schema = """
    `avg_queue_s` Int64,
    `machine_type` String,
    `count` Int64,
    `time` DateTime64(9)
    """

    url = f"https://{bucket}.s3.amazonaws.com/{encode_url_component(key)}"

    def get_insert_query(compression):
        return f"""
        insert into {table}
        select *, ('{bucket}', '{key}')
        from s3('{url}', 'JSONEachRow', '{schema}', '{compression}')
        """

    try:
        get_clickhouse_client().query(get_insert_query("gzip"))
    except:
        get_clickhouse_client().query(get_insert_query("none"))


def external_contribution_stats_adapter(table, bucket, key) -> None:
    schema = """
    `date` String,
    `pr_count` Int64,
    `user_count` Int64,
    `users` Array(String)
    """
    url = f"https://{bucket}.s3.amazonaws.com/{encode_url_component(key)}"

    def get_insert_query(compression):
        return f"""
        insert into {table}
        select *, ('{bucket}', '{key}')
        from s3('{url}', 'JSONEachRow', '{schema}', '{compression}',
            extra_credentials(
                role_arn = 'arn:aws:iam::308535385114:role/clickhouse_role'
            )
        )
        """

    try:
        get_clickhouse_client().query(get_insert_query("gzip"))
    except Exception as e:
        get_clickhouse_client().query(
            f"insert into errors.gen_errors ('{table}', '{bucket}', '{key}', '{json.dumps(str(e))}')"
        )


SUPPORTED_PATHS = {
    "merges": "default.merges",
    "queue_times_historical": "default.queue_times_historical",
    "test_run": "default.test_run_s3",
    "test_run_summary": "default.test_run_summary",
    "merge_bases": "default.merge_bases",
    "failed_test_runs": "default.failed_test_runs",
    "rerun_disabled_tests": "default.rerun_disabled_tests",
    "external_contribution_counts": "misc.external_contribution_stats",
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
}


def extract_clickhouse_table_name(bucket, key) -> Optional[str]:
    """
    Extract the DynamoDB table name from the source ARN. This will be used later as
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
