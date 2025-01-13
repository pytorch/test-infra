#!/usr/bin/env python3
"""
For copying a dynamoDB table to ClickHouse. Best run on a machine with multiple cores
using screen/tmux.
"""

import datetime
import json
import os
import time
from argparse import ArgumentParser
from functools import lru_cache
from multiprocessing import Pool
from typing import Any, Dict, Optional, Union

import boto3
import clickhouse_connect
import line_profiler
from prefetch_generator import BackgroundGenerator


S3_RESOURCE = boto3.resource("s3")
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
def get_dynamo_client():
    return boto3.client("dynamodb")


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
        "--dynamodb-table",
        type=str,
        required=True,
        help="the name of the source dynamoDB table",
    )
    # For parallel scan, but I haven't actually tested it
    # https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html#Scan.ParallelScan
    parser.add_argument(
        "--segment",
        type=int,
        default=0,
    )
    parser.add_argument(
        "--total-segments",
        type=int,
        default=1,
    )
    return parser.parse_args()


def scan_dynamodb_table(
    dynamo_client: Any,
    table: str,
    exclusive_start_key: Optional[str],
    segment: int,
    total_segments: int,
) -> Any:
    """
    Generates all the items in a DynamoDB table
    """
    paginator = dynamo_client.get_paginator("scan")

    # paginate expects ExclusiveStartKey to be a dictionary and errors when it
    # is null.  TODO: figure out if the empty dictionary results in starting
    # from the beginning
    if exclusive_start_key is None:
        for page in paginator.paginate(
            TableName=table, Segment=segment, TotalSegments=total_segments
        ):
            yield (page["Items"], page.get("LastEvaluatedKey", None))
            if "LastEvaluatedKey" not in page:
                break
    else:
        for page in paginator.paginate(
            TableName=table,
            ExclusiveStartKey=exclusive_start_key,
            Segment=segment,
            TotalSegments=total_segments,
        ):
            yield (page["Items"], page.get("LastEvaluatedKey", None))
            if "LastEvaluatedKey" not in page:
                break


def to_number(s: str) -> Union[int, float]:
    try:
        return int(s)
    except ValueError:
        return float(s)


def unmarshal(doc: Dict[Any, Any]) -> Any:
    """
    Convert the DynamoDB stream record into a regular JSON document. This is done recursively.
    At the top level, it will be a dictionary of type M (Map). Here is the list of DynamoDB
    attributes to handle:

    https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_streams_AttributeValue.html
    """
    for k, v in list(doc.items()):
        if k == "NULL":
            return

        if k == "S" or k == "BOOL":
            return v

        if k == "N":
            return to_number(v)

        if k == "M":
            return {sk: unmarshal(sv) for sk, sv in v.items()}

        if k == "BS" or k == "L":
            return [unmarshal(item) for item in v]

        if k == "SS":
            return v.copy()

        if k == "NS":
            return [to_number(item) for item in v]


def upload_to_clickhouse(records, table):
    body = ""
    for record in records:
        body += json.dumps(record) + "\n"
    # Async insert to maybe make insertions more efficient on the ClickHouse side
    # https://clickhouse.com/docs/en/cloud/bestpractices/asynchronous-inserts
    get_clickhouse_client().query(
        f"INSERT INTO {table}  SETTINGS async_insert=1, wait_for_async_insert=1  FORMAT JSONEachRow {body}"
    )


def handle_workflow_job(record: Any) -> Any:
    # No longer needed but keeping it here for reference.  Sometimes we need to
    # do some data transformation
    if "torchci_classification" in record:
        torchci_classification = record["torchci_classification"]
        if "captures" in torchci_classification and isinstance(
            torchci_classification["captures"], str
        ):
            torchci_classification["captures"] = [torchci_classification["captures"]]
        if "context" in torchci_classification and isinstance(
            torchci_classification["context"], str
        ):
            torchci_classification["context"] = [torchci_classification["context"]]
    return record


ADAPTERS = {"torchci-workflow-job": handle_workflow_job}


def wait_for_async_and_save(
    async_res, stored_data_file, last_evaluated_key, item_count, stored_data
) -> None:
    for r in async_res:
        r.get()
    if last_evaluated_key is not None:
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


@line_profiler.profile
def backfill_dynamo(
    dynamodb_table: str,
    clickhouse_table: str,
    stored_data_file: str,
    segment: int,
    total_segments: int,
) -> None:
    """
    Upload from dynamo into clickhouse
    """

    with open(stored_data_file, "r") as f:
        stored_data = json.load(f)

    exclusive_start_key = stored_data.get("exclusive_start_key", None)

    # For calculating the rate
    item_count = 0
    time_start = time.time()

    # For counting number of times the scan has been called
    batch_count = 0

    # Still not sure what the optimal numbers are.  I'm pretty sure the dynamodb
    # reads are the bottleneck
    pool_size = 12
    pool = Pool(pool_size)
    CH_UPLOAD_BATCHSIZE = 400
    max_prefetch = pool_size * 4

    # For keeping track of the async results
    async_res = []

    # Uses threads to generate the next batch of items while the current batch
    # runs to reduce the wait time for the next batch
    # https://github.com/justheuristic/prefetch_generator
    for items, last_evaluated_key in BackgroundGenerator(
        scan_dynamodb_table(
            get_dynamo_client(),
            table=dynamodb_table,
            exclusive_start_key=exclusive_start_key,
            segment=segment,
            total_segments=total_segments,
        ),
        max_prefetch=max_prefetch,
    ):
        batch_count += 1
        records = []
        for item in items:
            item_count += 1
            record = unmarshal({"M": item})
            record = ADAPTERS.get(dynamodb_table, lambda x: x)(record)
            records.append(record)
            if len(records) >= CH_UPLOAD_BATCHSIZE:
                async_res.append(
                    pool.apply_async(
                        upload_to_clickhouse, args=(records, clickhouse_table)
                    )
                )
                records = []
        if len(records) > 0:
            async_res.append(
                pool.apply_async(upload_to_clickhouse, args=(records, clickhouse_table))
            )

        # I want to save the last evaluated key, but I also want to make sure
        # that everything before the last evaluated key has already been
        # uploaded, so I wait for all the async results to finish before saving.
        # This introduces a sync point, which is not ideal
        if len(async_res) >= pool_size or last_evaluated_key is None:
            async_res = wait_for_async_and_save(
                async_res, stored_data_file, last_evaluated_key, item_count, stored_data
            )

        # Print out a bunch of stuff to keep track of progress
        print(last_evaluated_key)
        if batch_count % 20 == 0:
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


def main() -> None:
    args = parse_args()
    backfill_dynamo(
        args.dynamodb_table,
        args.clickhouse_table,
        args.stored_data,
        args.segment,
        args.total_segments,
    )


if __name__ == "__main__":
    main()
