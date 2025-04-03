import csv
import json
import os
import re
from collections import defaultdict
from enum import Enum
from typing import Any, Dict, Optional
from warnings import warn

import boto3
import clickhouse_connect
from dateutil import parser

CLICKHOUSE_ENDPOINT = os.getenv("CLICKHOUSE_ENDPOINT", "")
CLICKHOUSE_USERNAME = os.getenv("CLICKHOUSE_USERNAME", "default")
CLICKHOUSE_PASSWORD = os.getenv("CLICKHOUSE_PASSWORD", "")
CLICKHOUSE_TABLE = "servicelab_torch_dynamo_perf_stats"

S3_CLIENT = boto3.client("s3")
# https://clickhouse.com/docs/en/integrations/python
CLICKHOUSE_CLIENT = clickhouse_connect.get_client(
    host=CLICKHOUSE_ENDPOINT,
    user=CLICKHOUSE_USERNAME,
    password=CLICKHOUSE_PASSWORD,
    secure=True,
)

METADATA_REGEX = re.compile(
    r"pytorch/benchmarks/dynamo/manifold/(?P<experiment_id>\d+)/(?P<trial_id>\d+)/(?P<compiler>\w+)-(?P<model>\w+)-(?P<mode>\w+)-(?P<benchmark_type>\w+)-\w+\.\w+\.\d+_?(?P<retry>\d+)?\.(?P<experiment_type>\w+)-\w+\.csv"
)


class EventType(Enum):
    PUT = "ObjectCreated"


def lambda_handler(event: Any, context: Any) -> None:
    counts = defaultdict(int)
    for record in event["Records"]:
        event_name = record.get("eventName", "")
        try:
            if event_name.startswith(EventType.PUT.value):
                upsert_document(record)
            else:
                warn(f"Unrecognized event type {event_name} in {json.dumps(record)}")

            counts[event_name] += 1
        except Exception as error:
            warn(f"Failed to process {json.dumps(record)}: {error}")

    print(f"Finish processing {json.dumps(counts)}")


def extract_bucket(record: Any) -> Optional[str]:
    return record.get("s3", {}).get("bucket", {}).get("name", None)


def extract_key(record: Any) -> Optional[str]:
    return record.get("s3", {}).get("object", {}).get("key", None)


def extract_metadata(record: Any) -> Dict[str, Any]:
    key = extract_key(record)
    m = re.match(METADATA_REGEX, key)
    if not m:
        print(f"Failed to extract metadata from {key}")
        return {}

    return {
        "id": key.replace(".csv", ""),
        "servicelab_experiment_id": m["experiment_id"],
        "servicelab_experiment_type": m["experiment_type"],
        "servicelab_trial_id": m["trial_id"],
        "epoch_timestamp": int(
            parser.parse(record.get("eventTime")).timestamp() * 1000
        ),
        "compiler": m["compiler"],
        "mode": m["mode"],
        # TODO (huydhn): Only TorchBench models are supported for now, not HF or TIMM
        "suite": "torchbench",
        # TODO (huydhn): Figure out a way to not hardcode this field
        "dtype": "bfloat16" if m["mode"] == "inference" else "amp",
        "benchmark_type": m["benchmark_type"],
    }


def read_csv(bucket: str, key: str):
    response = S3_CLIENT.get_object(Bucket=bucket, Key=key)
    for r in csv.DictReader(
        response["Body"].read().decode("utf-8").split("\n"), delimiter=","
    ):
        yield r


def upsert_document(record: Any) -> None:
    """
    Insert a new doc or modify an existing document. Note that ClickHouse doesn't really
    update the document in place, but rather adding a new record for the update
    """
    bucket, key = extract_bucket(record), extract_key(record)
    if not bucket or not key:
        return

    metadata = extract_metadata(record)
    if not metadata:
        return

    count = 0
    body_str = ""
    for r in read_csv(bucket, key):
        count += 1

        # Populate the record metadata
        r.update(metadata)
        body_str += json.dumps(r) + "\n"

    if body_str:
        print(f"INSERTING {count} records into {CLICKHOUSE_TABLE}")
        CLICKHOUSE_CLIENT.query(
            f"INSERT INTO `{CLICKHOUSE_TABLE}` FORMAT JSONEachRow {body_str}"
        )


if os.getenv("DEBUG", "0") == "1":
    mock_body = {
        "Records": [
            # A mock example with the original retry field in ServiceLab result CSV
            {
                "eventVersion": "2.1",
                "eventSource": "aws:s3",
                "awsRegion": "us-east-1",
                "eventTime": "2024-08-16T17:03:21.686Z",
                "eventName": "ObjectCreated:Put",
                "userIdentity": {
                    "principalId": "AWS:AROAUPVRELQNILZ34DHTP:hyperloop_worker@svc"
                },
                "requestParameters": {"sourceIPAddress": ""},
                "responseElements": {"x-amz-request-id": "", "x-amz-id-2": ""},
                "s3": {
                    "s3SchemaVersion": "1.0",
                    "configurationId": "deebdf19-9805-4e91-8b87-fcc7c1197872",
                    "bucket": {
                        "name": "ossci-benchmarks",
                        "ownerIdentity": {"principalId": "A30JR6FIYKGDQS"},
                        "arn": "arn:aws:s3:::ossci-benchmarks",
                    },
                    "object": {
                        "key": "pytorch/benchmarks/dynamo/manifold/3901375723/3902231115/defaults-nanogpt-training-performance-benchmark_torchbench_run_nanogpt_training.benchmark_torchbench_run_nanogpt_training.3902231115_1.a-tmp694bm90e.csv",
                        "size": 310,
                        "eTag": "cb5cc0599d7a8283606316f2ff58b49c",
                        "sequencer": "0066BF8659A2FDB5EE",
                    },
                },
            },
            # A mock example without the retry field (it started to happen since Sep 3rd 2024)
            {
                "eventVersion": "2.1",
                "eventSource": "aws:s3",
                "awsRegion": "us-east-1",
                "eventTime": "2024-08-19T15:20:02.000Z",
                "eventName": "ObjectCreated:Put",
                "userIdentity": {
                    "principalId": "AWS:AROAUPVRELQNILZ34DHTP:hyperloop_worker@svc"
                },
                "requestParameters": {"sourceIPAddress": ""},
                "responseElements": {"x-amz-request-id": "", "x-amz-id-2": ""},
                "s3": {
                    "s3SchemaVersion": "1.0",
                    "configurationId": "deebdf19-9805-4e91-8b87-fcc7c1197872",
                    "bucket": {
                        "name": "ossci-benchmarks",
                        "ownerIdentity": {"principalId": "A30JR6FIYKGDQS"},
                        "arn": "arn:aws:s3:::ossci-benchmarks",
                    },
                    "object": {
                        "key": "pytorch/benchmarks/dynamo/manifold/4500202979/4500315921/cudagraphs_dynamic-BERT_pytorch-training-performance-benchmark_torchbench_run_bert_pytorch_training.benchmark_torchbench_run_bert_pytorch_training.4500315921.a-tmphjxk9w2x.csv",
                        "size": 310,
                        "eTag": "cb5cc0599d7a8283606316f2ff58b49c",
                        "sequencer": "0066BF8659A2FDB5EE",
                    },
                },
            }
        ]
    }
    lambda_handler(mock_body, None)
