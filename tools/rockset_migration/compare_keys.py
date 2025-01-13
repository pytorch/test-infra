"""
Helper script to compare dynamo keys present between Rockset and Clickhouse, and
upload missing keys to Clickhouse if any are missing
"""

import os
from argparse import ArgumentParser
from functools import lru_cache
from typing import Any, List

import rockset
from dynamo2ch import (
    ADAPTERS,
    get_clickhouse_client,
    get_dynamo_client,
    unmarshal,
    upload_to_clickhouse,
)


CLICKHOUSE_ENDPOINT = os.environ.get("CLICKHOUSE_ENDPOINT", "localhost")
CLICKHOUSE_USERNAME = os.environ.get("CLICKHOUSE_USERNAME", "default")
CLICKHOUSE_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "default")


@lru_cache
def get_rockset_client():
    return rockset.RocksetClient(
        host="api.usw2a1.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    )


CLICKHOUSE_TABLE_TO_DYNAMO_TABLE = {
    "issue_comment": "torchci-issue-comment",
    "issues": "torchci-issues",
    "pull_request": "torchci-pull-request",
    "push": "torchci-push",
    "workflow_run": "torchci-workflow-run",
    "workflow_job": "torchci-workflow-job",
    "pull_request_review": "torchci-pull-request-review",
    "pull_request_review_comment": "torchci-pull-request-review-comment",
}


def insert_missing_keys(ch_table: str, keys: List[str]):
    records = []
    for key in keys:
        res = get_dynamo_client().query(
            TableName=CLICKHOUSE_TABLE_TO_DYNAMO_TABLE[ch_table],
            KeyConditionExpression="dynamoKey = :dynamoKey",
            ExpressionAttributeValues={":dynamoKey": {"S": key}},
        )

        body = unmarshal({"M": res["Items"][0]})
        body = ADAPTERS.get(CLICKHOUSE_TABLE_TO_DYNAMO_TABLE[ch_table], lambda x: x)(
            body
        )
        records.append(body)
    upload_to_clickhouse(records, ch_table)


def parse_args() -> Any:
    parser = ArgumentParser("Copy dynamoDB table to ClickHouse")
    parser.add_argument(
        "--table",
        type=str,
        required=True,
        help="the names of the tables to cmopare",
    )

    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    clickhouse_ids = []
    with get_clickhouse_client().query_rows_stream(
        f"select dynamoKey from {args.table} final"
    ) as stream:
        count = 0
        for s in stream:
            count += 1
            clickhouse_ids.append(s[0])

    rockset_ids = []
    for rockset_id in (
        get_rockset_client().sql(f"select dynamoKey from {args.table}").results
    ):
        rockset_ids.append(rockset_id["dynamoKey"])

    print(
        f"ClickHouse has {len(clickhouse_ids)} rows, {len(set(clickhouse_ids))} unique keys, "
        f"num dups: {len(clickhouse_ids) - len(set(clickhouse_ids))}\n"
        f"Rockset    has {len(rockset_ids)} rows, {len(set(rockset_ids))} unique keys, "
        f"num dups: {len(rockset_ids) - len(set(rockset_ids))}\n"
        f"Unique keys, clickhouse - rockset: {len(set(clickhouse_ids)) - len(set(rockset_ids))}"
    )

    # difference = set(clickhouse_ids) - set(rockset_ids)
    # for key in difference:
    #     print(f"Key {key} in ClickHouse but not in Rockset")

    other_difference = set(rockset_ids) - set(clickhouse_ids)
    # for key in other_difference:
    #     print(f"Key {key} in Rockset but not in ClickHouse")
    insert_missing_keys(args.table, list(other_difference))
