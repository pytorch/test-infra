#!/usr/bin/env python
import argparse
import boto3
import os
import json
import logging
from datetime import datetime, timedelta, timezone
import clickhouse_connect
import copy

# Local imports
from typing import Any, Optional, Dict, Set, Iterable, List
from dateutil.parser import parse
from datetime import datetime, timezone, timedelta

logging.basicConfig(
    level=logging.INFO,
)
logger = logging.getLogger()
logger.setLevel("INFO")

ENVS = {
    "CLICKHOUSE_ENDPOINT": os.getenv("CLICKHOUSE_ENDPOINT", ""),
    "CLICKHOUSE_PASSWORD": os.getenv("CLICKHOUSE_PASSWORD", ""),
    "CLICKHOUSE_USERNAME": os.getenv("CLICKHOUSE_USERNAME", ""),
}


def get_clickhouse_client(
    host: str, user: str, password: str
) -> clickhouse_connect.driver.client.Client:
    # for local testing only, disable SSL verification
    # return clickhouse_connect.get_client( host=host, user=user, password=password, secure=True, verify=False)

    return clickhouse_connect.get_client(
        host=host, user=user, password=password, secure=True
    )


def get_clickhouse_client_environment() -> clickhouse_connect.driver.client.Client:
    for name, env_val in ENVS.items():
        if not env_val:
            raise ValueError(f"Missing environment variable {name}")
    return get_clickhouse_client(
        host=ENVS["CLICKHOUSE_ENDPOINT"],
        user=ENVS["CLICKHOUSE_USERNAME"],
        password=ENVS["CLICKHOUSE_PASSWORD"],
    )


def validate_datetime(dt_str):
    try:
        datetime.strptime(dt_str, "%Y-%m-%dT%H:%M:%SZ")
        return dt_str
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"Invalid datetime format: '{dt_str}'. Expected format: YYYY-MM-DDTHH:MM:SSZ"
        )


def get_data_from_ce(client, start, end):
    logger.info(
        f"Fetching data from aws cost explorer endpoint within time range {start} to {end} ....."
    )
    return client.get_cost_and_usage(
        TimePeriod={
            "Start": start,
            "End": end,
        },
        Granularity="HOURLY",
        Metrics=["UsageQuantity"],
        GroupBy=[
            {"Type": "DIMENSION", "Key": "INSTANCE_TYPE"},
            {"Type": "DIMENSION", "Key": "USAGE_TYPE"},
        ],
        Filter={
            "Dimensions": {
                "Key": "SERVICE",
                "Values": ["Amazon Elastic Compute Cloud - Compute"],
            }
        },
    )


def parse_args() -> argparse.Namespace:
    """
    Parse command line args, this is mainly used for local test environment.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--clickhouse-endpoint",
        default=ENVS["CLICKHOUSE_ENDPOINT"],
        type=str,
        help="the clickhouse endpoint, the clickhouse_endpoint name is  https://{clickhouse_endpoint}:{port} for full url ",
    )
    parser.add_argument(
        "--clickhouse-username",
        type=str,
        default=ENVS["CLICKHOUSE_USERNAME"],
        help="the clickhouse username",
    )
    parser.add_argument(
        "--clickhouse-password",
        type=str,
        default=ENVS["CLICKHOUSE_PASSWORD"],
        help="the clickhouse password for the user name",
    )
    parser.add_argument(
        "--not-dry-run",
        action="store_true",
        help="when set, writing results to destination from local environment. By default, we run in dry-run mode for local environment",
    )
    parser.add_argument(
        "--start-time",
        type=validate_datetime,
        required=False,
        help="Start time in UTC ISO8601 format (e.g. 2025-05-28T00:00:00Z)",
    )
    parser.add_argument(
        "--end-time",
        type=validate_datetime,
        required=False,
        help="End time in UTC ISO8601 format (e.g. 2025-05-29T00:00:00Z)",
    )
    args, _ = parser.parse_known_args()
    return args


def main(args: Optional[argparse.Namespace] = None, is_dry_run: bool = False):
    # set up initialization for clickhouse and arguments based on running environments
    time_now = datetime.now(timezone.utc)
    logger.info(f"Starting job at utc time {time_now}")

    # pick time range for day before by default, since aws cost exploerer has delay to geenrate data
    end_time = datetime.now(timezone.utc).date()
    start_time = end_time - timedelta(days=1)

    start = start_time.strftime("%Y-%m-%dT%H:%M:%SZ")
    end = end_time.strftime("%Y-%m-%dT%H:%M:%SZ")

    aws_ce_client = boto3.client("ce")

    if args:
        cc = get_clickhouse_client(
            args.clickhouse_endpoint, args.clickhouse_username, args.clickhouse_password
        )
        if args.start_time:
            start = args.start_time
        if args.end_time:
            end = args.end_time
    else:
        cc = get_clickhouse_client_environment()

    data = get_data_from_ce(aws_ce_client, start, end)
    results = data.get("ResultsByTime", [])

    if len(results) == 0:
        logger.info("no result data is found from aws ce")
        return
    else:
        logger.info(f"detecting {len(results)} time series data point from aws ce")

    logger.info(f"Flattening the raw data into pre-db records .....")
    # extra and flatten aws result to pre-db record
    recordList = processCostExplorerResults(results)
    logger.info(f"Done. Flattening the raw data into pre-db records")

    if len(recordList) > 0:
        logger.info(f"Peeking the record: {json.dumps(recordList[0])}")
    else:
        logger.info(f"No  pre-db records were generated")
        return

    logger.info(f"Generating db records .....")
    db_records = []
    for record in recordList:
        db_rec = to_db_schema(record, "meta-runner-ec", "hourly")
        if not db_rec:
            continue
        db_records.append(db_rec)
    logger.info(f"Done. Generated {len(db_records)} db records .....")
    logger.info(f"Peeking the db record: {json.dumps(db_records[0])}")

    if is_dry_run:
        logger.info(f"run in dry-run mode, skipping writing to db")
        print(json.dumps(db_records))
        return
    else:
        insert_to_db(cc, db_records)


def insert_to_db(
    cc: clickhouse_connect.driver.client.Client, records: List[Dict[str, Any]]
):
    db_name = "misc"
    db_table_name = "oss_ci_aws_ce_tracking"
    logger.info(f" Insert data to db table: {db_name}.{db_table_name}")
    if len(records) == 0:
        logger.info(f" No histogram records, skipping writing..")
        return
    columns = list(records[0].keys())
    data = [list(record.values()) for record in records]
    cc.insert(
        table=db_table_name,
        data=data,
        column_names=columns,
        database=db_name,
    )
    logger.info(f" done. Insert {len(data)} to db table: {db_name}.{db_table_name}")


def to_db_schema(record, type, granularity):
    keys = record.get("Keys", [])
    endTime = record.get("End")
    endtimeDate = endTime.replace("Z", "+00:00")
    now = datetime.now(timezone.utc).isoformat()
    if len(keys) < 2:
        logger.warning(
            f"Expected two keys from Record, but got {len(record)}, skipping the record"
        )
        return None
    return {
        "created": now,
        "type": type,
        "granularity": granularity,
        "time": endtimeDate,
        "instance_type": keys[0],
        "usage_type": keys[1],
        "unit": record.get("Unit", ""),
        "value": record.get("Amount", 0),
        "extra_info": {},
        "tags": [],
    }


def processCostExplorerResults(resp_reults):
    filtered = copy.deepcopy(resp_reults)
    # filter NoInstanceType since it's normally related to other usages
    for res in filtered:
        # filted Groups with keys `NoInstanceType``
        filtered_groups = [
            group
            for group in res.get("Groups", [])
            if "NoInstanceType" not in group.get("Keys", [])
        ]
        res["Groups"] = filtered_groups

    # flatten the aws results in to a record ready for clickhouse schema conversion
    res = []
    for ts_record in filtered:
        falttened_list = flatten_ts_record(ts_record)
        res.extend(falttened_list)
    return res


def flatten_ts_record(record):
    """
    return {'Start': '2025-05-28T00:00:00Z', 'End': '2025-05-28T01:00:00Z', 'Keys': ['c5.12xlarge', 'BoxUsage:c5.12xlarge'], 'Amount': '157.445277', 'Unit': 'Hrs'}
    """
    results = []
    start = record.get("TimePeriod", {}).get("Start")
    end = record.get("TimePeriod", {}).get("End")
    for group in record["Groups"]:
        new_group = {}
        new_group["Start"] = start
        new_group["End"] = end
        new_group["Keys"] = group.get("Keys", [])
        usage_quantity = group.get("Metrics", {}).get("UsageQuantity", {})
        new_group["Amount"] = usage_quantity.get("Amount", 0)
        new_group["Unit"] = usage_quantity.get("Unit", 0)
        results.append(new_group)
    return results


def local_run() -> None:
    args = parse_args()
    # always run in dry-run mode in local environment, unless it's disabled.

    is_dry_run = not args.not_dry_run
    if is_dry_run:
        logger.info(f"run locally with dry run mode")
    main(args, is_dry_run)


def lambda_handler(event, context):
    main()


if __name__ == "__main__":
    local_run()
