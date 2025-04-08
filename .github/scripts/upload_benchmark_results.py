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
from json.decoder import JSONDecodeError
from logging import info
from typing import Any, Callable, Dict, List, Optional
from warnings import warn

import boto3  # type: ignore[import-not-found]


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


class ValidateMetadata(Action):
    def __call__(
        self,
        parser: ArgumentParser,
        namespace: Namespace,
        values: Any,
        option_string: Optional[str] = None,
    ) -> None:
        try:
            decoded_values = json.loads(values)
        except JSONDecodeError:
            parser.error(f"{values} is not a valid JSON")
            return

        if all(
            k in decoded_values
            for k in (
                "timestamp",
                "schema_version",
                "name",
                "repo",
                "head_branch",
                "head_sha",
                "workflow_id",
                "run_attempt",
                "job_id",
            )
        ):
            setattr(namespace, self.dest, decoded_values)
            return

        parser.error(f"{values} is not a valid benchmark metadata")


class ValidateJSON(Action):
    def __call__(
        self,
        parser: ArgumentParser,
        namespace: Namespace,
        values: Any,
        option_string: Optional[str] = None,
    ) -> None:
        try:
            decoded_values = json.loads(values)
        except JSONDecodeError:
            parser.error(f"{values} is not a valid JSON")
            return

        setattr(namespace, self.dest, decoded_values)


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
    parser.add_argument(
        "--metadata",
        type=str,
        required=True,
        action=ValidateMetadata,
        help="the metadata to use in JSON format",
    )
    parser.add_argument(
        "--runners",
        type=str,
        default=json.dumps([]),
        action=ValidateJSON,
        help="the information about the benchmark runners in JSON format",
    )
    parser.add_argument(
        "--dependencies",
        type=str,
        default=json.dumps({}),
        action=ValidateJSON,
        help="the information about the benchmark dependencies in JSON format",
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
    msg = f"Writing {len(docs)} documents to DynamoDB {dynamodb_table}"
    info(msg)
    if not dry_run:
        # https://boto3.amazonaws.com/v1/documentation/api/latest/guide/dynamodb.html#batch-writing
        with boto3.resource("dynamodb").Table(dynamodb_table).batch_writer() as batch:
            for doc in docs:
                doc["timestamp"] = int(round(time.time() * 1000))
                if generate_partition_key:
                    doc["dynamoKey"] = generate_partition_key(doc)
                batch.put_item(Item=doc)


def read_benchmark_results(filepath: str) -> List[Dict[str, Any]]:
    benchmark_results = []
    with open(filepath) as f:
        try:
            r = json.load(f)
            # Handle the JSONEachRow case where there is only one record in the
            # JSON file, it can still be loaded normally, but will need to be
            # added into the list of benchmark results with the length of 1
            if isinstance(r, dict):
                benchmark_results.append(r)
            elif isinstance(r, list):
                benchmark_results = r

        except JSONDecodeError:
            f.seek(0)

            # Try again in ClickHouse JSONEachRow format
            for line in f:
                try:
                    r = json.loads(line)
                    # Each row needs to be a dictionary in JSON format or a list
                    if isinstance(r, dict):
                        benchmark_results.append(r)
                    elif isinstance(r, list):
                        benchmark_results.extend(r)
                    else:
                        warn(f"Not a JSON dict or list {line}, skipping")
                        continue

                except JSONDecodeError:
                    warn(f"Invalid JSON {line}, skipping")

    return benchmark_results


def process_benchmark_results(
    filepath: str,
    metadata: Dict[str, Any],
    runners: List[Any],
    dependencies: Dict[str, Any],
) -> List[Dict[str, Any]]:
    benchmark_results = read_benchmark_results(filepath)
    if not benchmark_results or not isinstance(benchmark_results, (list, tuple)):
        return []

    processed_benchmark_results: List[Dict[str, Any]] = []
    for result in benchmark_results:
        # This is a required field
        if "metric" not in result:
            warn(f"{result} from {filepath} is not a benchmark record, skipping")
            continue

        record: Dict[str, Any] = {**metadata, **result}
        # Gather all the information about the benchmark
        if "runners" not in record:
            record["runners"] = runners
        if "dependencies" not in record:
            record["dependencies"] = dependencies

        processed_benchmark_results.append(record)
    return processed_benchmark_results


def generate_s3_path(
    benchmark_results: List[Dict[str, Any]], filepath: str, schema_version: str
) -> Optional[str]:
    if not benchmark_results:
        return None

    repo = ""
    workflow_id = 0
    job_id = 0

    for result in benchmark_results:
        repo = result.get("repo", "")
        if not repo:
            continue

        workflow_id = result.get("workflow_id", 0)
        job_id = result.get("job_id", 0)
        servicelab_experiment_id = result.get("servicelab_experiment_id", 0)
        servicelab_trial_id = result.get("servicelab_trial_id", 0)

        # Also handle service lab records here
        workflow_id = workflow_id if workflow_id else servicelab_experiment_id
        job_id = job_id if job_id else servicelab_trial_id

        # We just need one record here to get some metadata to generate the s3 path
        if workflow_id and job_id:
            break

    if not repo or not workflow_id or not job_id:
        info(
            "The result is without any information about the repo, workflow, or job id"
        )
        return None

    filename = os.path.basename(filepath)
    return f"{schema_version}/{repo}/{workflow_id}/{job_id}/{filename}"


def upload_to_s3(
    s3_bucket: str,
    filepath: str,
    schema_version: str,
    benchmark_results: List[Dict[str, Any]],
    dry_run: bool = True,
) -> None:
    """
    Upload the benchmark results to S3
    """
    s3_path = generate_s3_path(benchmark_results, filepath, schema_version)
    if not s3_path:
        msg = f"Could not generate an S3 path for {filepath}, skipping..."
        info(msg)
        return

    msg = f"Upload {filepath} to s3://{s3_bucket}/{s3_path}"
    info(msg)
    if not dry_run:
        # Write in JSONEachRow format
        data = "\n".join([json.dumps(result) for result in benchmark_results])
        boto3.resource("s3").Object(
            f"{s3_bucket}",
            f"{s3_path}",
        ).put(
            Body=gzip.compress(data.encode()),
            ContentEncoding="gzip",
            ContentType="application/json",
        )


def main() -> None:
    args = parse_args()

    for file in os.listdir(args.benchmark_results_dir):
        if not file.endswith(".json"):
            continue

        filepath = os.path.join(args.benchmark_results_dir, file)
        schema_version = args.metadata["schema_version"]

        # NB: This is for backward compatibility before we move to schema v3
        if schema_version == "v2":
            with open(filepath) as f:
                msg = f"Uploading {filepath} to dynamoDB ({schema_version})"
                info(msg)
                upload_to_dynamodb(
                    dynamodb_table=args.dynamodb_table,
                    # NB: DynamoDB only accepts decimal number, not float
                    docs=json.load(f, parse_float=Decimal),
                    generate_partition_key=generate_partition_key,
                    dry_run=args.dry_run,
                )

        benchmark_results = process_benchmark_results(
            filepath=filepath,
            metadata=args.metadata,
            runners=args.runners,
            dependencies=args.dependencies,
        )

        if not benchmark_results:
            continue

        upload_to_s3(
            s3_bucket=OSSCI_BENCHMARKS_BUCKET,
            filepath=filepath,
            schema_version=schema_version,
            benchmark_results=benchmark_results,
            dry_run=args.dry_run,
        )


if __name__ == "__main__":
    main()
