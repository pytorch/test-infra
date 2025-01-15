#!/usr/bin/env python3
"""
For copying from s3 to ClickHouse. Best run on a machine with multiple cores
using screen/tmux.
"""

import datetime
import importlib
import json
import os
import sys
import time
import urllib
from argparse import ArgumentParser
from functools import lru_cache
from multiprocessing import Pool
from pathlib import Path
from typing import Any, Optional

import boto3
import clickhouse_connect
import line_profiler
from prefetch_generator import BackgroundGenerator


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(REPO_ROOT))
lambda_function = importlib.import_module(
    "aws.lambda.clickhouse-replicator-s3.lambda_function"
)
sys.path.pop()


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


ADAPTERS = lambda_function.OBJECT_CONVERTER


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
                ADAPTERS[clickhouse_table], args=(clickhouse_table, bucket, key)
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
