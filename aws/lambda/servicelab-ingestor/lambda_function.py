import datetime
import gzip
import json
import os
from collections import defaultdict
from enum import Enum
from typing import Any, Dict, List, Optional
from warnings import warn

import boto3
import clickhouse_connect

CLICKHOUSE_ENDPOINT = os.getenv("CLICKHOUSE_ENDPOINT", "")
CLICKHOUSE_USERNAME = os.getenv("CLICKHOUSE_USERNAME", "default")
CLICKHOUSE_PASSWORD = os.getenv("CLICKHOUSE_PASSWORD", "")

S3_CLIENT = boto3.client("s3")
# https://clickhouse.com/docs/en/integrations/python
# CLICKHOUSE_CLIENT = clickhouse_connect.get_client(
#     host=CLICKHOUSE_ENDPOINT,
#     user=CLICKHOUSE_USERNAME,
#     password=CLICKHOUSE_PASSWORD,
#     secure=True,
# )


class EventType(Enum):
    PUT = "ObjectCreated"


def lambda_handler(event: Any, context: Any) -> None:
    counts = defaultdict(int)
    for record in event["Records"]:
        event_name = record.get("eventName", "")
        try:
            if event_name.startswith(EventType.PUT.value):
                warn(f"PUT {event_name} in {json.dumps(record)}")
                # upsert_document(clickhouse_client, record)
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


def get_s3_object(bucket: str, key: str):
    response = s3.get_object(Bucket=bucket, Key=key)
    return response["Body"].read()


def to_utf8(body):
    return body.decode("utf-8")


def unzip(body):
    return gzip.decompress(body)


def read_no_zip_json(body):
    return [json.loads(to_utf8(body))]


def upsert_document(client: Any, record: Any) -> None:
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

    body = get_s3_object(bucket, key)
    body = OBJECT_CONVERTER.get(table, read_no_zip_json)(body)
    print(f"body size: {len(body)}")
    if not body:
        return

    batch_size = 100
    for i in range(0, len(body), batch_size):
        body_str = ""
        for item in body[i : i + batch_size]:
            body_str += json.dumps(item) + "\n"

        # TODO (huydhn) Inserting individual record is not efficient according
        # to ClickHouse doc, but we can try to improve this later. See more at
        # https://clickhouse.com/docs/en/optimize/bulk-inserts
        print(f"UPSERTING {key}: {body_str[:1000]} INTO {table}")
        # Checkout https://clickhouse.com/videos/how-to-upsert-rows-into-clickhouse
        # to understand how to upsert works in ClickHouse and how to get the latest
        # records. A generic way is to use the FINAL keyword but their doc mentions
        # that it's slower https://clickhouse.com/docs/en/sql-reference/statements/select/from
        client.query(f"INSERT INTO `{table}` FORMAT JSONEachRow {body_str}")
