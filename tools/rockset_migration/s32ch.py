#!/usr/bin/env python3
"""
For copying from s3 to ClickHouse. Best run on a machine with multiple cores
using screen/tmux.
"""

import datetime
from functools import lru_cache
import gzip
import json
from multiprocessing import Pool
import os
import time
from argparse import ArgumentParser
from typing import Any, Optional
import urllib


import boto3
import clickhouse_connect
import line_profiler
from prefetch_generator import BackgroundGenerator


CLICKHOUSE_ENDPOINT = os.environ.get("CLICKHOUSE_ENDPOINT", "localhost")
CLICKHOUSE_USERNAME = os.environ.get("CLICKHOUSE_USERNAME", "username")
CLICKHOUSE_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "password")


# Hopefully this will cache the client for each pool/thread worker
@lru_cache()
def get_clickhouse_client() -> Any:
    clickhouse_client = clickhouse_connect.get_client(
        host=CLICKHOUSE_ENDPOINT,
        user=CLICKHOUSE_USERNAME,
        password=CLICKHOUSE_PASSWORD,
        secure=True,
    )
    return clickhouse_client


@lru_cache()
def get_s3_client():
    return boto3.resource("s3")


def encode_url_component(url):
    return urllib.parse.quote(url)


def parse_args() -> Any:
    parser = ArgumentParser("Copy dynamoDB table to ClickHouse")
    parser.add_argument(
        "--clickhouse-table",
        type=str,
        required=True,
        help="the name of the ClickHouse table",
    )
    parser.add_argument(
        "--stored-data",
        type=str,
        required=True,
        help=(
            "the name of file containing info between runs. ",
            "Should be a JSON file with a dict. ",
            "It will get written to periodically so that the script can be restarted and pick up where it left off",
        ),
    )
    parser.add_argument(
        "--s3-bucket",
        type=str,
        required=True,
        help="the name of the s3 bucket where the data is stored",
    )
    parser.add_argument(
        "--s3-prefix",
        type=str,
        required=True,
        help="prefix for the s3 bucket where the data is stored",
    )
    return parser.parse_args()


def scan_s3_bucket(bucket: str, prefix: str, last_evaluated_key: Optional[str] = None):
    # Generator for scanning an s3 bucket.  last_evaluated_key is the key to
    # start from (exclusive)
    bucket = get_s3_client().Bucket(bucket)
    objs = bucket.objects.filter(Prefix=f"{prefix}/")

    found_last_evaluated_key = False
    if last_evaluated_key is None:
        found_last_evaluated_key = True

    for obj in objs:
        if not found_last_evaluated_key:
            if obj.key == last_evaluated_key:
                found_last_evaluated_key = True
            continue
        yield obj.key


def upload_to_clickhouse(records, table):
    body = ""
    for record in records:
        body += json.dumps(record) + "\n"
    # Async insert to maybe make insertions more efficient on the ClickHouse side
    # https://clickhouse.com/docs/en/cloud/bestpractices/asynchronous-inserts
    get_clickhouse_client().query(
        f"INSERT INTO `{table}`  SETTINGS async_insert=1, wait_for_async_insert=1  FORMAT JSONEachRow {body}"
    )


def clean_up_query(query):
    # Good for printing the query for debugging purposes
    return " ".join([line.strip() for line in query.split("\n")])


def handle_test_run_s3(bucket, key, table):
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
        {get_skipped_failure_parser_helper('error', 'Tuple(type String, message String, text String)', 'type')},
        {get_skipped_failure_parser_helper('failure', 'Tuple(type String, message String, text String)', 'type')},
        file,
        invoking_file,
        job_id,
        line::Int64,
        name,
        properties,
        {get_skipped_failure_parser_helper('rerun', 'Tuple(message String, text String)', 'type')},
        result,
        {get_skipped_failure_parser_helper('skipped', 'Tuple(type String, message String, text String)', 'type')},
        status,
        {get_sys_err_out_parser('system-err')},
        {get_sys_err_out_parser('system-out')},
        time,
        time_inserted,
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
            `time_inserted` DateTime64(9),
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


def merge_bases_adapter(bucket, key, table):
    schema = """
    `changed_files` Array(String),
    `merge_base` String,
    `merge_base_commit_date` DateTime64(3),
    `repo` String,
    `sha` String
    """

    def get_insert_query(compression):
        return f"""
        insert into {table}
        select *, ('{bucket}', '{key}')
        from s3('{url}', 'JSONEachRow', '{schema}', '{compression}')
        """

    url = f"https://{bucket}.s3.amazonaws.com/{encode_url_component(key)}"
    try:
        get_clickhouse_client().query(get_insert_query("gzip"))
    except:
        get_clickhouse_client().query(get_insert_query("none"))


def queue_times_historical_adapter(bucket, key, table):
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


def rerun_disabled_tests_adapter(bucket, key, table):
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


ADAPTERS = {
    "failed_test_runs": handle_test_run_s3,
    "rerun_disabled_tests": rerun_disabled_tests_adapter,
    "merge_bases": merge_bases_adapter,
    "queue_times_historical_2": queue_times_historical_adapter,
}


def wait_for_async_and_save(
    async_res, stored_data_file, last_evaluated_key, item_count, stored_data
) -> None:
    for r in async_res:
        r.get()
    if last_evaluated_key is not None:
        # Unlike the dynamo version, last_evaluated_key shouldn't be none at the
        # end, but check just in case
        with open(stored_data_file, "w") as f:
            f.write(
                json.dumps(
                    {
                        "exclusive_start_key": last_evaluated_key,
                        "items_scanned": stored_data.get("items_scanned", 0)
                        + item_count,
                        "total_items": stored_data.get("total_items", 0),
                    }
                )
            )
    return []


@line_profiler.profile  # not needed but useful for finding bottlenecks
def backfill_s3(
    bucket: str,
    prefix: str,
    clickhouse_table: str,
    stored_data_file: str,
) -> None:
    """
    Upload from s3 into clickhouse
    """

    with open(stored_data_file, "r") as f:
        stored_data = json.load(f)

    exclusive_start_key = stored_data.get("exclusive_start_key", None)

    # For calculating the rate
    time_start = time.time()

    # For counting number of times the scan has been called
    batch_count = 0

    # I'm still not sure what the optimal numbers are
    pool_size = 30
    pool = Pool(pool_size)
    max_prefetch = pool_size * 3

    # For keeping track of the async results
    async_res = []

    # Uses threads to generate the next batch of items while the current batch
    # runs to reduce the wait time for the next batch
    # https://github.com/justheuristic/prefetch_generator
    for key in BackgroundGenerator(
        scan_s3_bucket(
            bucket=bucket,
            prefix=prefix,
            last_evaluated_key=exclusive_start_key,
        ),
        max_prefetch=max_prefetch,
    ):
        batch_count += 1
        item_count = batch_count

        async_res.append(
            pool.apply_async(
                ADAPTERS[clickhouse_table], args=(bucket, key, clickhouse_table)
            )
        )

        if len(async_res) >= pool_size * 5:
            async_res = wait_for_async_and_save(
                async_res, stored_data_file, key, item_count, stored_data
            )
            # Print out a bunch of stuff to keep track of progress
            elapsed_time = time.time() - time_start
            time_remaining = (elapsed_time / item_count) * (
                stored_data.get("total_items", 0)
                - stored_data.get("items_scanned", 0)
                - item_count
            )

            time_remaining = datetime.timedelta(seconds=time_remaining)
            est_eta = datetime.datetime.now() + time_remaining

            est_eta_human_readable = est_eta.strftime("%H:%M:%S")
            time_remaining_human_readable = str(time_remaining)
            if est_eta.date() != datetime.datetime.now().date():
                days_remaining = (est_eta.date() - datetime.datetime.now().date()).days
                est_eta_human_readable = f"{days_remaining}d {est_eta}"

            print(
                f"Est ETA: {est_eta_human_readable} ({time_remaining_human_readable}). "
                + f"Scanned {item_count} items in {round(elapsed_time, 2)}s.  Rate: {round(elapsed_time / item_count, 4)}s/i."
            )

    wait_for_async_and_save(async_res, stored_data_file, key, item_count, stored_data)


def main() -> None:
    args = parse_args()
    backfill_s3(
        bucket=args.s3_bucket,
        prefix=args.s3_prefix,
        clickhouse_table=args.clickhouse_table,
        stored_data_file=args.stored_data,
    )


if __name__ == "__main__":
    main()
