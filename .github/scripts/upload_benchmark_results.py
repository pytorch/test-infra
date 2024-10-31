#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the BSD-style license found in the
# LICENSE file in the root directory of this source tree.

import gzip
import hashlib
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


OSSCI_BENCHMARKS_BUCKET = "ossci-benchmarks"


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
    # v3 is defined at torchci/clickhouse_queries/oss_ci_benchmark_v3/query.sql
    parser.add_argument(
        "--schema-version",
        choices=["v2", "v3"],
        required=True,
        help="the database schema to use",
    )

    return parser.parse_args()


# DynamoDB use Decimal, not float
class DecimalEncoder(json.JSONEncoder):
    def default(self, o: Any) -> Any:
        if isinstance(o, Decimal):
            return str(o)
        return super().default(o)


def generate_partition_key(doc: Dict[str, Any]) -> str:
    """
    Generate an unique partition key for the document on DynamoDB
    """
    repo = doc["repo"]
    workflow_id = doc["workflow_id"]
    job_id = doc["job_id"]
    test_name = doc["test_name"]
    filename = doc["filename"]

    hash_content = hashlib.md5(
        json.dumps(doc, cls=DecimalEncoder).encode("utf-8")
    ).hexdigest()
    return f"{repo}/{workflow_id}/{job_id}/{test_name}/{filename}/{hash_content}"


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
    if not dry_run:
        # https://boto3.amazonaws.com/v1/documentation/api/latest/guide/dynamodb.html#batch-writing
        with boto3.resource("dynamodb").Table(dynamodb_table).batch_writer() as batch:
            for doc in docs:
                doc["timestamp"] = int(round(time.time() * 1000))
                if generate_partition_key:
                    doc["dynamoKey"] = generate_partition_key(doc)
                batch.put_item(Item=doc)


def generate_s3_path(filepath: str, schema_version: str) -> Optional[str]:
    with open(filepath) as f:
        docs = json.load(f)

        if not docs:
            info(f"{filepath} is empty")
            return ""

        for doc in docs:
            repo = doc.get("repo", "")
            workflow_id = doc.get("workflow_id", 0)
            job_id = doc.get("job_id", 0)
            servicelab_experiment_id = doc.get("servicelab_experiment_id", 0)
            servicelab_trial_id = doc.get("servicelab_trial_id", 0)

            # Also handle service lab records here
            workflow_id = workflow_id if workflow_id else servicelab_experiment_id
            job_id = job_id if job_id else servicelab_trial_id

            # We just need one record here to get some metadata to generate the s3 path
            if repo and workflow_id and job_id:
                break

        if not repo or not workflow_id or not job_id:
            info(
                f"{filepath} is without any information about the repo, workflow, or job id"
            )
            return ""

    filename = os.path.basename(filepath)
    return f"{schema_version}/{repo}/{workflow_id}/{job_id}/{filename}"


def upload_to_s3(
    s3_bucket: str,
    filepath: str,
    schema_version: str,
    dry_run: bool = True,
) -> None:
    """
    Upload the benchmark results to S3
    """
    s3_path = generate_s3_path(filepath, schema_version)
    if not s3_path:
        info(f"Could not generate an S3 path for {filepath}, skipping...")
        return

    info(f"Upload {filepath} to s3://{s3_bucket}/{s3_path}")
    if not dry_run:
        # Copied from upload stats script
        with open(filepath) as f:
            boto3.resource("s3").Object(
                f"{s3_bucket}",
                f"{s3_path}",
            ).put(
                Body=gzip.compress(f.read().encode()),
                ContentEncoding="gzip",
                ContentType="application/json",
            )


def main() -> None:
    args = parse_args()
    schema_version = args.schema_version

    for file in os.listdir(args.benchmark_results_dir):
        if not file.endswith(".json"):
            continue

        filepath = os.path.join(args.benchmark_results_dir, file)

        # NB: This is for backward compatibility before we move to schema v3
        if schema_version == "v2":
            with open(filepath) as f:
                info(f"Uploading {filepath} to dynamoDB ({schema_version})")
                upload_to_dynamodb(
                    dynamodb_table=args.dynamodb_table,
                    # NB: DynamoDB only accepts decimal number, not float
                    docs=json.load(f, parse_float=Decimal),
                    generate_partition_key=generate_partition_key,
                    dry_run=args.dry_run,
                )

        upload_to_s3(
            s3_bucket=OSSCI_BENCHMARKS_BUCKET,
            filepath=filepath,
            schema_version=schema_version,
            dry_run=args.dry_run,
        )


if __name__ == "__main__":
    main()
