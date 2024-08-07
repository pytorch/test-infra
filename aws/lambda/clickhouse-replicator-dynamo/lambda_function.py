import json
import os
import re
from collections import defaultdict
from enum import Enum
from typing import Any, Dict, Optional, Union
from warnings import warn

import clickhouse_connect


DYNAMODB_TABLE_REGEX = re.compile(
    "arn:aws:dynamodb:.*?:.*?:table/(?P<table>[0-9a-zA-Z_-]+)/.+"
)
CLICKHOUSE_ENDPOINT = os.getenv("CLICKHOUSE_ENDPOINT", "")
CLICKHOUSE_USERNAME = os.getenv("CLICKHOUSE_USERNAME", "default")
CLICKHOUSE_PASSWORD = os.getenv("CLICKHOUSE_PASSWORD", "")
SUPPORTED_TABLES = {
    "torchci-workflow-job": "workflow_job_1"
}

class EventType(Enum):
    INSERT = "INSERT"
    REMOVE = "REMOVE"
    MODIFY = "MODIFY"


def lambda_handler(event: Any, context: Any) -> None:
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
                event_name == EventType.INSERT.value
                or event_name == EventType.MODIFY.value
            ):
                upsert_document(clickhouse_client, record)
            elif event_name == EventType.REMOVE.value:
                remove_document(clickhouse_client, record)
            else:
                warn(f"Unrecognized event type {event_name} in {json.dumps(record)}")

            counts[event_name] += 1
        except Exception as error:
            warn(f"Failed to process {json.dumps(record)}: {error}")

    print(f"Finish processing {json.dumps(counts)}")


def extract_dynamodb_table(record: Any) -> Optional[str]:
    """
    Extract the DynamoDB table name from the source ARN. This will be used later as
    the index name
    """
    table = record.get("tableName", "")
    # In the case of a Kinesis stream, the table name has already been provided
    if table:
        return table

    s = record.get("eventSourceARN", "")
    m = DYNAMODB_TABLE_REGEX.match(s)
    if not m:
        warn(f"Invalid value {s}, expecting a DynamoDB table")
        return

    dynamo_table = m.group("table")
    if dynamo_table not in SUPPORTED_TABLES:
        raise RuntimeError(f"Unsupported table {dynamo_table}")
    return SUPPORTED_TABLES[dynamo_table]


def extract_dynamodb_key(record: Any) -> Optional[str]:
    keys = unmarshal({"M": record.get("dynamodb", {}).get("Keys", {})})
    if not keys:
        return
    return "|".join(keys.values())


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


def handle_workflow_job(record: Any) -> Any:
    """
    CREATE TABLE default.workflow_job_1
    (
        `completed_at` DateTime64(9),
        `conclusion` String,
        `head_branch` String,
        `head_sha` String,
        `html_url` String,
        `id` Int64,
        `labels` Array(String),
        `name` String,
        `run_attempt` Int64,
        `run_id` Int64,
        `run_url` String,
        `runner_group_name` String,
        `runner_name` String,
        `started_at` DateTime64(9),
        `status` String,
        `torchci_classification_captures` Array(String),
        `torchci_classification_context` Array(String),
        `torchci_classification_line` String,
        `torchci_classification_line_num` Int64,
        `torchci_classification_rule` String,
        `workflow_name` String,
        `check_run_url` String,
        `created_at` DateTime64(9),
        `dynamoKey` String,
        `runner_group_id` Int64,
        `runner_id` Int64,
        `steps` Array(Tuple(completed_at DateTime64(9), conclusion String, name String, number Int64, started_at DateTime64(9), status String)),
        `url` String
    )
    """
    torchci_classification = record.get("torchci_classification", {})
    steps = record.get("steps", [])
    for step in steps:
        step["completed_at"] = step.get("completed_at", "")
        step["conclusion"] = step.get("conclusion", "")
        step["name"] = step.get("name", "")
        step["number"] = step.get("number", 0)
        step["started_at"] = step.get("started_at", "")
        step["status"] = step.get("status", "")

    return {
        "completed_at": record.get("completed_at"),
        "conclusion": record.get("conclusion"),
        "head_branch": record.get("head_branch"),
        "head_sha": record.get("head_sha"),
        "html_url": record.get("html_url"),
        "id": record.get("id"),
        "labels": record.get("labels", []),
        "name": record.get("name"),
        "run_attempt": record.get("run_attempt"),
        "run_id": record.get("run_id"),
        "run_url": record.get("run_url"),
        "runner_group_name": record.get("runner_group_name"),
        "runner_name": record.get("runner_name"),
        "started_at": record.get("started_at"),
        "status": record.get("status"),
        "torchci_classification_captures": torchci_classification.get("captures", []),
        "torchci_classification_context": torchci_classification.get("context", []),
        "torchci_classification_line": torchci_classification.get("line"),
        "torchci_classification_line_num": torchci_classification.get("line_num"),
        "torchci_classification_rule": torchci_classification.get("rule"),
        "workflow_name": record.get("workflow_name"),
        "check_run_url": record.get("check_run_url"),
        "created_at": record.get("created_at"),
        "dynamoKey": record.get("dynamoKey"),
        "runner_group_id": record.get("runner_group_id"),
        "runner_id": record.get("runner_id"),
        "steps": steps,
    }


def upsert_document(client: Any, record: Any) -> None:
    """
    Insert a new doc or modify an existing document. Note that ClickHouse doesn't really
    update the document in place, but rather adding a new record for the update
    """
    table = extract_dynamodb_table(record)
    if not table:
        return

    body = unmarshal({"M": record.get("dynamodb", {}).get("NewImage", {})})
    if not body:
        return
    if table == "workflow_job_1":
        body = handle_workflow_job(body)

    id = extract_dynamodb_key(record)
    if not id:
        return

    # TODO (huydhn) Inserting individual record is not efficient according
    # to ClickHouse doc, but we can try to improve this later. See more at
    # https://clickhouse.com/docs/en/optimize/bulk-inserts
    print(f"UPSERTING {id}: {json.dumps(body)} INTO {table}")
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
    table = extract_dynamodb_table(record)
    if not table:
        return

    id = extract_dynamodb_key(record)
    if not id:
        return

    print(f"DELETING {id} FROM {table}")

    parameters = {"id": id}
    client.query(
        f"DELETE FROM `{table}` WHERE dynamoKey = %(id)s", parameters=parameters
    )
