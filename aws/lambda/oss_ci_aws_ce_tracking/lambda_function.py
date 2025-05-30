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
from typing import Any, Optional, Dict, List
from datetime import datetime, timezone, timedelta

# Set up logging
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

DB_NAME = "fortesting"
DB_TABLE_NAME = "oss_ci_ce_tracking"


def insert_to_db(
    client: clickhouse_connect.driver.client.Client,
    records: List[Dict[str, Any]],
    db_name: str,
    db_table_name: str,
):
    logger.info(f"Preparing to insert data into table: {db_name}.{db_table_name}")

    if not records:
        logger.info("No records to insert, skipping database write operation.")
        return

    columns = list(records[0].keys())
    data = [list(record.values()) for record in records]

    logger.info(f"Inserting {len(data)} records into {db_name}.{db_table_name}")
    client.insert(
        table=db_table_name,
        data=data,
        column_names=columns,
        database=db_name,
    )
    logger.info(
        f"Successfully inserted {len(data)} records into {db_name}.{db_table_name}"
    )


def get_clickhouse_client(
    host: str, user: str, password: str, is_local: bool = False
) -> clickhouse_connect.driver.client.Client:
    # for local testing only, disable SSL verification

    # Only use in local development
    if is_local:
        return clickhouse_connect.get_client(
            host=host, user=user, password=password, secure=True, verify=False
        )

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


def validate_datetime(dt_str: str):
    """
    use to validate the datetime string in the format of "YYYY-MM-DD" for local run input
    """
    try:
        return datetime.strptime(dt_str, "%Y-%m-%d")
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"Invalid datetime format: '{dt_str}'. Expected format: YYYY-MM-DD"
        )


class CostExplorerProcessor:
    """
    A processor for fetching, processing, and inserting AWS Cost Explorer data into a ClickHouse database.

    Attributes:
    - is_dry_run (bool): Indicates if the processor is running in dry-run mode, where no data is inserted into the database.
    - aws_ce_client (boto3.client): A boto3 client for interacting with AWS Cost Explorer.
    - cc (clickhouse_connect.driver.client.Client): A ClickHouse client for database operations, initialized at runtime.
    - granularity (str): The granularity of the data to fetch from AWS Cost Explorer, default is "DAILY".
    """

    def __init__(self, is_dry_run: bool = False):
        self.is_dry_run = is_dry_run
        self.aws_ce_client = boto3.client("ce")
        self.cc = None  # clickhouse client set in runtime
        self.granularity = "DAILY"

    def _fetch(self, client: Any, start: str, end: str, granularity="HOURLY"):
        logger.info(
            f"Fetching data from aws cost explorer endpoint within time range {start} to {end} ....."
        )
        return client.get_cost_and_usage(
            TimePeriod={
                "Start": start,
                "End": end,
            },
            Granularity=granularity,
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

    def _process_raw_ce_data(self, resp_reults: List[Dict[str, Any]]):
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

        # flatten the aws results in to a record that is ready for clickhouse schema conversion
        res = []
        for ts_record in filtered:
            falttened_list = self.flatten_ts_record(ts_record)
            res.extend(falttened_list)
        return res

    def flatten_ts_record(self, record: Dict[str, Any]) -> List[Dict[str, Any]]:
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

    def to_db_schema(
        self, record: Dict[str, Any], record_type: str, granularity: str
    ) -> Optional[Dict[str, Any]]:
        keys = record.get("Keys", [])
        startTime = record.get("Start", "").replace("Z", "+00:00")
        now = datetime.now(timezone.utc).isoformat()
        if len(keys) < 2:
            logger.warning(
                f"Expected two keys from Record, but got {len(record)} keys:{keys}, skipping the record"
            )
            return None
        return {
            "created": now,
            "type": record_type,
            "granularity": granularity,
            "time": startTime,
            "instance_type": keys[0],
            "usage_type": keys[1],
            "unit": record.get("Unit", ""),
            "value": record.get("Amount", 0),
            "extra_info": {},
            "tags": [],
        }

    def start(self, args: Optional[argparse.Namespace] = None):
        """
        Starts the processor
        Parameters:
        - args (Optional[argparse.Namespace]): Command-line arguments for local execution.
        """

        # set up time range for fetching data from AWS Cost Explorer
        time_now = datetime.now(timezone.utc)
        logger.info(f"Starting job at UTC time {time_now}")

        end_time = datetime.now(timezone.utc).date() - timedelta(days=1)
        start_time = end_time - timedelta(days=1)

        start = start_time.strftime("%Y-%m-%d")
        end = end_time.strftime("%Y-%m-%d")

        # set up clickhouse client based on running environments
        if args:
            logger.info(
                "Running with provided command-line arguments for local environment."
            )
            self.cc = get_clickhouse_client(
                args.clickhouse_endpoint,
                args.clickhouse_username,
                args.clickhouse_password,
                is_local=True,
            )
            if args.start_time:
                start = args.start_time.strftime("%Y-%m-%d")
            if args.end_time:
                end = args.end_time.strftime("%Y-%m-%d")
        else:
            logger.info("Running with environment variables.")
            self.cc = get_clickhouse_client_environment()

        # Fetch data from AWS Cost Explorer
        data = self._fetch(self.aws_ce_client, start, end, self.granularity)
        results = data.get("ResultsByTime", [])
        if not results:
            logger.info("No result data found from AWS Cost Explorer.")
            return
        else:
            logger.info(
                f"Detected {len(results)} time series data points from AWS Cost Explorer."
            )

        # Convert data into database records
        logger.info("Flattening the raw data into pre-database records.")
        recordList = self._process_raw_ce_data(results)
        logger.info("Completed flattening the raw data into pre-database records.")

        if recordList:
            logger.info(f"Peeking the first record: {json.dumps(recordList[0])}")
            logger.info(f"Peeking the last record: {json.dumps(recordList[-1])}")
        else:
            logger.info("No pre-database records were generated.")
            return

        logger.info("Generating database records.")
        db_records = []
        for record in recordList:
            db_rec = self.to_db_schema(record, "meta-runner-ec", self.granularity)
            if db_rec:
                db_records.append(db_rec)
        logger.info(f"Generated {len(db_records)} database records.")
        if db_records:
            logger.info(
                f"Peeking the first database record: {json.dumps(db_records[0])}"
            )

        # Insert records
        if self.is_dry_run:
            logger.info("Running in dry-run mode, skipping database insertion.")
            return
        else:
            logger.info("Inserting records into the database.")
            insert_to_db(self.cc, db_records, DB_NAME, DB_TABLE_NAME)


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


# Usage
def local_run() -> None:
    args = parse_args()
    is_dry_run = not args.not_dry_run
    processor = CostExplorerProcessor(is_dry_run)
    processor.start(args)


def lambda_handler(event: Any, context: Any) -> None:
    processor = CostExplorerProcessor()
    processor.start()


if __name__ == "__main__":
    local_run()
