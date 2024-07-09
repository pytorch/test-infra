#!/usr/bin/env python3

import logging
import pickle
import hashlib
import json
import os
import time
from argparse import ArgumentParser
from typing import Any, Dict

import boto3

import rockset  # type: ignore[import]
from dateutil import parser  # type: ignore[import]
from rockset import QueryPaginator, RocksetClient


PAGE_SIZE = 1000


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
    workflow_id = doc.get("workflow_id", "")
    if workflow_id:
        doc["workflow_id"] = int(workflow_id)
    job_id = doc.get("job_id", "")
    test_name = doc.get("test_name", "")
    filename = doc.get("filename", "")

    hash_content = hashlib.md5(json.dumps(doc).encode("utf-8")).hexdigest()
    return f"{repo}/{workflow_id}/{job_id}/{test_name}/{filename}/{hash_content}"


def copy(
    workspace: str, collection: str, dynamodb_table: str, repo: str = "pytorch/pytorch"
) -> None:
    rs = RocksetClient(
        host="api.usw2a1.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    )

    count = 0
    query = f"SELECT * FROM {workspace}.{collection}"
    for docs in QueryPaginator(
        rs,
        rs.Queries.query(
            sql=rockset.models.QueryRequestSql(
                query=query,
                paginate=True,
                initial_paginate_response_doc_count=PAGE_SIZE,
            )
        ),
    ):
        dedup = set()
        count += len(docs)
        failures = []
        print(f"Writing {len(docs)} ({count}) documents to DynamoDB {dynamodb_table}")
        # https://boto3.amazonaws.com/v1/documentation/api/latest/guide/dynamodb.html#batch-writing
        with boto3.resource("dynamodb").Table(dynamodb_table).batch_writer() as batch:
            for doc in docs:
                event_time = doc.get("_event_time", None)
                if event_time:
                    timestamp = int(round(parser.parse(str(event_time)).timestamp() * 1000))
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
                    failures.append(doc)
                    # Record and ignore broken records
                    logging.warning("...%s failures", len(failures))
                    continue

                # This is to move away the _event_time field from Rockset, which we cannot use when
                # reimport the data
                doc["timestamp"] = timestamp

                try:
                    batch.put_item(Item=doc)
                except TypeError:
                    failures.append(doc)
                    # Record and ignore broken records
                    logging.warning("...%s failures", len(failures))
                    continue

        if failures:
            with open("failures.dump", "wb") as f:
                pickle.dump(failures, f)


def main() -> None:
    args = parse_args()
    copy(
        args.rockset_workspace, args.rockset_collection, args.dynamodb_table, args.repo
    )


if __name__ == "__main__":
    main()
