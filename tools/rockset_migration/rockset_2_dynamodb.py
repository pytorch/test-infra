#!/usr/bin/env python3

import hashlib
import json
import logging
import os
import time
from argparse import ArgumentParser
from typing import Any, Dict, List

import boto3
from dateutil import parser  # type: ignore[import]
from rockset import RocksetClient  # type: ignore[import]
from rockset.models import QueryParameter, QueryRequestSql  # type: ignore[import]


def parse_args() -> Any:
    parser = ArgumentParser("Copy Rockset collection to dynamoDB")
    parser.add_argument(
        "--rockset-workspace",
        type=str,
        required=True,
        help="the name of the Rockset workspace with the collection",
    )
    parser.add_argument(
        "--rockset-collection",
        type=str,
        required=True,
        help="the name of the Rockset collection to copy",
    )
    parser.add_argument(
        "--dynamodb-table",
        type=str,
        required=True,
        help="the name of the destination dynamoDB table",
    )
    parser.add_argument(
        "--repo",
        type=str,
        default="pytorch/pytorch",
        help="this is used as part of dynamoDB key",
    )
    return parser.parse_args()


def generate_partition_key(repo: str, doc: Dict[str, Any]) -> str:
    """
    Generate an unique partition key for the document on DynamoDB
    """
    workflow_id = int(doc.get("workflow_id", 0))
    job_id = int(doc.get("job_id", 0))
    test_name = doc.get("test_name", "")
    filename = doc.get("filename", "")

    hash_content = hashlib.md5(json.dumps(doc).encode("utf-8")).hexdigest()
    return f"{repo}/{workflow_id}/{job_id}/{test_name}/{filename}/{hash_content}"


def get_workflow_ids(
    rs_client: RocksetClient, workspace: str, collection: str
) -> List[int]:
    """
    Attempt to query the whole 3M+ records from some table fails with Rockset returns
    gibberish, so we need to make the query smaller by processing each workflow id
    sequentially
    """
    query = f"SELECT DISTINCT workflow_id FROM {workspace}.{collection} GROUP BY workflow_id"
    docs = rs_client.sql(query=query)
    return [int(doc["workflow_id"]) for doc in docs["results"]]


def copy_perf_stats(
    workspace: str, collection: str, dynamodb_table: str, repo: str = "pytorch/pytorch"
) -> None:
    rs = RocksetClient(
        host="api.usw2a1.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    )

    # Break down by workflow ID, issuing a select all statement to Rockset returns gibberish
    # data in some fields
    workflow_ids = get_workflow_ids(rs, workspace, collection)

    count = 0
    query = f"SELECT * FROM {workspace}.{collection} WHERE workflow_id = : workflow_id"

    for workflow_id in workflow_ids:
        print(f"Processing {workflow_id}")
        docs = rs.Queries.query(
            sql=QueryRequestSql(
                parameters=[
                    QueryParameter(
                        name="workflow_id",
                        type="int",
                        value=str(workflow_id),
                    ),
                ],
                query=query,
            )
        )["results"]

        dedup = set()
        count += len(docs)
        failures = 0
        print(f"Writing {len(docs)} ({count}) documents to DynamoDB {dynamodb_table}")
        # https://boto3.amazonaws.com/v1/documentation/api/latest/guide/dynamodb.html#batch-writing
        with boto3.resource("dynamodb").Table(dynamodb_table).batch_writer() as batch:
            for doc in docs:
                event_time = doc.get("_event_time", None)
                if event_time:
                    timestamp = int(
                        round(parser.parse(str(event_time)).timestamp() * 1000)
                    )
                else:
                    timestamp = int(round(time.time() * 1000))

                # We don't need these fields from Rockset
                del doc["_event_time"]
                del doc["_id"]
                del doc["_meta"]

                try:
                    if generate_partition_key:
                        doc["dynamoKey"] = generate_partition_key(repo, doc)
                        if doc["dynamoKey"] in dedup:
                            continue
                        dedup.add(doc["dynamoKey"])
                except TypeError:
                    failures += 1
                    # Record and ignore broken records
                    logging.warning("...%s failures", failures)
                    continue

                # This is to move away the _event_time field from Rockset, which we cannot use when
                # reimport the data
                doc["timestamp"] = timestamp

                try:
                    # https://ruan.dev/blog/2019/02/05/convert-float-to-decimal-data-types-for-boto3-dynamodb-using-python
                    # doc = json.loads(json.dumps(doc, default=str), parse_float=Decimal)
                    batch.put_item(Item=doc)
                except TypeError:
                    failures += 1
                    # Record and ignore broken records
                    logging.warning("...%s failures", failures)
                    continue


def main() -> None:
    args = parse_args()
    copy_perf_stats(
        args.rockset_workspace, args.rockset_collection, args.dynamodb_table, args.repo
    )


if __name__ == "__main__":
    main()
