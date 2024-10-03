#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the BSD-style license found in the
# LICENSE file in the root directory of this source tree.

import json
import logging
import os
import time
from argparse import Action, ArgumentParser, Namespace
from decimal import Decimal

from logging import info
from typing import Any, Callable, Dict, List, Optional

import boto3

logging.basicConfig(level=logging.INFO)


class ValidateDir(Action):
    def __call__(
        self,
        parser: ArgumentParser,
        namespace: Namespace,
        values: Any,
        option_string: Optional[str] = None,
    ) -> None:
        if os.path.isdir(values):
            setattr(namespace, self.dest, values)
            return

        parser.error(f"{values} is not a valid directory")


def parse_args() -> Any:
    from argparse import ArgumentParser

    parser = ArgumentParser("upload the benchmark results to OSS benchmark database")
    parser.add_argument(
        "--benchmark-results-dir",
        type=str,
        required=True,
        action=ValidateDir,
        help="the directory with all the benchmark results in JSON format",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
    )
    parser.add_argument(
        "--dynamodb-table",
        type=str,
        default="torchci-oss-ci-benchmark",
        help="the name of the DynamoDB table to upload to",
    )

    return parser.parse_args()


# TODO (huydhn): This can be replaced by S3 path once we move to S3
def generate_partition_key(doc: Dict[str, Any]) -> str:
    """
    Generate an unique partition key for the document on DynamoDB
    """
    repo = doc["repo"]
    workflow_id = doc["workflow_id"]
    job_id = doc["job_id"]
    test_name = doc["test_name"]
    filename = doc["filename"]

    return f"{repo}/{workflow_id}/{job_id}/{test_name}/{filename}"


def upload_to_dynamodb(
    dynamodb_table: str,
    docs: List[Any],
    generate_partition_key: Optional[Callable[[Dict[str, Any]], str]],
    dry_run: bool = True,
) -> None:
    """
    Copied from upload stats script
    """
    info(f"Writing {len(docs)} documents to DynamoDB {dynamodb_table}")
    print(docs)
    if not dry_run:
        # https://boto3.amazonaws.com/v1/documentation/api/latest/guide/dynamodb.html#batch-writing
        with boto3.resource("dynamodb").Table(dynamodb_table).batch_writer() as batch:
            for doc in docs:
                doc["timestamp"] = int(round(time.time() * 1000))
                if generate_partition_key:
                    doc["dynamoKey"] = generate_partition_key(doc)
                batch.put_item(Item=doc)


def main() -> None:
    args = parse_args()

    for file in os.listdir(args.benchmark_results_dir):
        if not file.endswith(".json"):
            continue

        filepath = os.path.join(args.benchmark_results_dir, file)
        info(f"Loading {filepath}")

        with open(filepath) as f:
            upload_to_dynamodb(
                dynamodb_table=args.dynamodb_table,
                # NB: DynamoDB only accepts decimal number, not float
                docs=json.load(f, parse_float=Decimal),
                generate_partition_key=generate_partition_key,
                dry_run=args.dry_run,
            )


if __name__ == "__main__":
    main()
