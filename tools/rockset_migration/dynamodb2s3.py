#!/usr/bin/env python3

import gzip
import io
import json
import uuid
from argparse import ArgumentParser
from typing import Any, Dict, List, Union

import boto3

S3_RESOURCE = boto3.resource("s3")
BATCH_SIZE = 1000


def parse_args() -> Any:
    parser = ArgumentParser("Copy dynamoDB table to ClickHouse")
    parser.add_argument(
        "--s3-bucket",
        type=str,
        required=True,
        help="the name of the S3 bucket",
    )
    parser.add_argument(
        "--s3-path",
        type=str,
        required=True,
        help="the name of the destination S3 path on the bucket",
    )
    parser.add_argument(
        "--dynamodb-table",
        type=str,
        required=True,
        help="the name of the source dynamoDB table",
    )
    return parser.parse_args()


def scan_dynamodb_table(dynamo_client: Any, table: str):
    """
    Generates all the items in a DynamoDB table
    """
    paginator = dynamo_client.get_paginator("scan")

    for page in paginator.paginate(TableName=table):
        yield from page["Items"]


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


def upload_to_s3(
    s3_bucket: str,
    s3_path: str,
    records: List[Dict[str, Any]],
) -> None:
    print(f"Writing {len(records)} documents to S3")
    body = io.StringIO()
    for r in records:
        json.dump(r, body)
        body.write("\n")

    filename = f"{uuid.uuid4()}.json"
    S3_RESOURCE.Object(
        f"{s3_bucket}",
        f"{s3_path}/{filename}",
    ).put(
        Body=body.getvalue().encode(),
        ContentType="application/json",
    )


def copy(dynamodb_table: str, s3_bucket: str, s3_path: str):
    """
    Copy everything from a dynamo table to ClickHouse
    """
    count = 0
    records = []

    dynamo_client = boto3.client("dynamodb")
    for item in scan_dynamodb_table(dynamo_client, table=dynamodb_table):
        count += 1
        records.append(unmarshal({"M": item}))

        if count == BATCH_SIZE:
            upload_to_s3(s3_bucket, s3_path, records)

            count = 0
            records = []

    if records:
        upload_to_s3(s3_bucket, s3_path, records)


def main() -> None:
    args = parse_args()
    copy(args.dynamodb_table, args.s3_bucket, args.s3_path)


if __name__ == "__main__":
    main()
