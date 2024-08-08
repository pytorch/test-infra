import json
import os
import re
from collections import defaultdict
from enum import Enum
from typing import Any, Dict, Optional, Union
from warnings import warn
import boto3
import clickhouse_connect

s3 = boto3.client("s3")
DYNAMODB_TABLE_REGEX = re.compile(
    "arn:aws:dynamodb:.*?:.*?:table/(?P<table>[0-9a-zA-Z_-]+)/.+"
)
CLICKHOUSE_ENDPOINT = os.getenv("CLICKHOUSE_ENDPOINT", "")
CLICKHOUSE_USERNAME = os.getenv("CLICKHOUSE_USERNAME", "default")
CLICKHOUSE_PASSWORD = os.getenv("CLICKHOUSE_PASSWORD", "")



class EventType(Enum):
    PUT = "ObjectCreated"
    REMOVE = "ObjectRemoved"


def lambda_handler(event: Any, context: Any) -> None:
    return
    # https://clickhouse.com/docs/en/integrations/python
    clickhouse_client = clickhouse_connect.get_client(
        host=CLICKHOUSE_ENDPOINT,
        user=CLICKHOUSE_USERNAME,
        password=CLICKHOUSE_PASSWORD,
        secure=True,
    )

    counts = defaultdict(int)
    for record in event["Records"]:
        event_name = record.get("eventName", "")
        try:
            if (
                event_name.startswith(EventType.PUT.value)
            ):
                upsert_document(clickhouse_client, record)
            elif event_name.startswith(EventType.REMOVE.value):
                remove_document(clickhouse_client, record)
            else:
                warn(f"Unrecognized event type {event_name} in {json.dumps(record)}")

            counts[event_name] += 1
        except Exception as error:
            warn(f"Failed to process {json.dumps(record)}: {error}")

    print(f"Finish processing {json.dumps(counts)}")


def extract_clickhouse_table_name(bucket, key) -> Optional[str]:
    """
    Extract the DynamoDB table name from the source ARN. This will be used later as
    the index name
    """
    if key is None:
        return None

    if key.startswith("merges"):
        return "merges"
    if key.startswith("queue_times_historical"):
        return "queue_times_historical"
    return None

def extract_bucket(record: Any) -> Optional[str]:
    return record.get("s3", {}).get("bucket", {}).get("name", None)

def extract_key(record: Any) -> Optional[str]:
    return record.get("s3", {}).get("object", {}).get("key", None)



def get_s3_object(bucket: str, key: str) -> Dict[str, Any]:
    response = s3.get_object(Bucket=bucket, Key=key)
    return json.loads(response["Body"].read().decode("utf-8"))


def upsert_document(client: Any, record: Any) -> None:
    """
    Insert a new doc or modify an existing document. Note that ClickHouse doesn't really
    update the document in place, but rather adding a new record for the update
    """
    bucket, key = extract_bucket(record), extract_key(record)
    if not bucket or not key:
        return

    table = extract_clickhouse_table_name(bucket, key)
    if not table:
        return

    body = get_s3_object(bucket, key)
    if not body:
        return

    # TODO (huydhn) Inserting individual record is not efficient according
    # to ClickHouse doc, but we can try to improve this later. See more at
    # https://clickhouse.com/docs/en/optimize/bulk-inserts
    print(f"UPSERTING {key}: {json.dumps(body)} INTO {table}")
    # Checkout https://clickhouse.com/videos/how-to-upsert-rows-into-clickhouse
    # to understand how to upsert works in ClickHouse and how to get the latest
    # records. A generic way is to use the FINAL keyword but their doc mentions
    # that it's slower https://clickhouse.com/docs/en/sql-reference/statements/select/from
    res = client.query(f"INSERT INTO `{table}` FORMAT JSONEachRow {json.dumps(body)}")
    print(res)


def remove_document(client: Any, record: Any) -> None:
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
    # client.query(
    #     f"DELETE FROM `{table}` WHERE dynamoKey = %(id)s", parameters=parameters
    # )
