#!/usr/bin/env python
import argparse
import io
import json
import logging
import os
import gzip

import boto3  # type: ignore[import]
import clickhouse_connect
from datetime import datetime, time

# Local imports
from functools import lru_cache
from logging import info
from typing import Any

logging.basicConfig(level=logging.INFO)

_bucket_name = "ossci-raw-job-status"
_in_queue_job_select_statement = """
SELECT
    DATE_DIFF(
        'second',
        job.created_at,
        {timestamp:DateTime}
    ) AS queue_s,
    workflow.repository.'full_name' AS repo,
    workflow.name AS workflow_name,
    job.name AS job_name,
    job.html_url,
    IF(
        LENGTH(job.labels) = 0,
        'N/A',
        IF(
            LENGTH(job.labels) > 1,
            job.labels[2],
            job.labels[1]
        )
    ) AS machine_type,
    toUnixTimestamp({timestamp:DateTime}) AS time,
    toUnixTimestamp(job.started_at) as started_at,
    toUnixTimestamp(job.created_at) as created_at
FROM
    default.workflow_job job FINAL
    JOIN default.workflow_run workflow FINAL ON workflow.id = job.run_id
"""

@lru_cache()
def get_clickhouse_client(host: str, user: str, password: str) -> Any:
    return clickhouse_connect.get_client(
        host=host, user=user, password=password, secure=True, verify=False
    )


@lru_cache()
def get_aws_s3_resource() -> Any:
    return boto3.resource("s3")


def get_clickhouse_client_environment() -> Any:
    for env in ["CLICKHOUSE_ENDPOINT", "CLICKHOUSE_USERNAME", "CLICKHOUSE_PASSWORD"]:
        if not os.getenv(env):
            raise ValueError(f"Missing environment variable {env}")

    return get_clickhouse_client(
        host=os.getenv("CLICKHOUSE_ENDPOINT"),
        user=os.getenv("CLICKHOUSE_USERNAME"),
        password=os.getenv("CLICKHOUSE_PASSWORD"),
    )


def upload_to_s3_txt(
    s3_client: Any,
    bucket_name: str,
    key: str,
    records: list[dict[str, Any]],
) -> None:
    info(f"Writing {len(records)} documents to S3 {bucket_name}/{key}")
    body = io.StringIO()
    for record in records:
        json.dump(record, body)
        body.write("\n")

    s3_client.Object(
        f"{bucket_name}",
        f"{key}",
    ).put(
        Body=gzip.compress(body.getvalue().encode()),
        ContentEncoding="gzip",
        ContentType="text/plain",
    )
    info(f"Done! Finish writing document to S3 {bucket_name}/{key} ")

def query_picked_up_job_for_given_snapshot(time:str,repo: str = 'pytorch/pytorch'):
    """
     this query is used to get jobs that were in queue in given snapshot time, but were picked up by workers later
    """
    s1 = """
    WITH possible_queued_jobs AS (
        SELECT
            id,
            run_id,
            started_at,
            created_at
        FROM default.workflow_job -- FINAL not needed since we just use this to filter a table that has already been FINALed
        WHERE
            started_at > ({timestamp:DateTime})
            AND created_at < ({timestamp:DateTime} - INTERVAL 5 MINUTE)
            AND created_at > ({timestamp:DateTime} - INTERVAL 1 WEEK)
    )"""

    s2 = """
    WHERE
        job.id IN (SELECT id FROM possible_queued_jobs)
        AND workflow.id IN (SELECT run_id FROM possible_queued_jobs)
        AND workflow.repository.'full_name' = {repo:String}
        AND job.status = 'completed'
        AND LENGTH(job.steps) != 0
        AND workflow.status = 'completed'
    ORDER BY
        queue_s DESC
    """
    query = s1 + _in_queue_job_select_statement + s2

    parameters={
        'timestamp': time ,
        'repo': repo,
    }
    return query,parameters

def query_in_queue_jobs_for_given_snapshot(time:str, repo:str = 'pytorch/pytorch'):
    """
        this query is used to get jobs that werre in queue in given snapshot time, and not being picked up by workers
    """
    s1 = """
    WITH possible_queued_jobs AS (
        SELECT
            id,
            run_id,
            started_at,
            created_at
        FROM default.workflow_job -- FINAL not needed since we just use this to filter a table that has already been FINALed
        WHERE
            status = 'queued'
            AND created_at < ({timestamp:DateTime} - INTERVAL 5 MINUTE)
            AND created_at > ({timestamp:DateTime} - INTERVAL 1 WEEK)
    )
    """
    s2 ="""
    WHERE
        job.id IN (SELECT id FROM possible_queued_jobs)
        AND workflow.id IN (SELECT run_id FROM possible_queued_jobs)
        AND workflow.repository.'full_name' = {repo:String}
        AND job.status = 'queued'
        AND LENGTH(job.steps) = 0
        AND workflow.status != 'completed'
    ORDER BY
        queue_s DESC
    """
    query = s1 + _in_queue_job_select_statement + s2
    parameters={
        'timestamp': time ,
        'repo': repo,
    }
    return query, parameters

class QueueTimeProcessor:
    """
    this class used to handle oss ci queue time data aggregations. Currently it fetches in-queue jobs from clickhouse at current time

    To run the main method:
       processor = QueueTimeProcessor(clickhouse_client,s3_client)
       processor.process()
    """
    def __init__(
        self, clickhouse_client: Any, s3_client: Any, is_dry_run: bool = False
    ) -> None:
        self.clickhouse_client = clickhouse_client
        self.s3_client = s3_client
        self.is_dry_run = is_dry_run

    def process(self) -> None:
        self.proceses_job_queue_times_historical()

    def proceses_job_queue_times_historical(self, timestamp:str = "", repo: str = 'pytorch/pytorch') -> None:
        # by default, we use current time as snapshot
        snapshot_time = str(int(datetime.now().timestamp()))
        if timestamp:
            snapshot_time = timestamp


        # fetches jobs that were in queue in given snapshot time, that are not being picked up by workers
        queued_query, queued_parameters = query_in_queue_jobs_for_given_snapshot(timestamp,repo)
        jobs_in_queue = self.process_in_queue_jobs(queued_query, queued_parameters)

        # fetches jobs that were in queue in given snapshot time, but were picked up by workers later of given snapshot time
        picked_query, picked_params = query_picked_up_job_for_given_snapshot(timestamp,repo)
        jobs_pick = self.process_in_queue_jobs(picked_query, picked_params)

        datetime_str = datetime.fromtimestamp(int(timestamp)).strftime('%Y-%m-%d %H:%M:%S')
        print(datetime_str,timestamp,len(jobs_in_queue),len(jobs_pick),)

        info(f"Found {len(jobs_in_queue)} jobs in queue, and {len(jobs_pick)} jobs was in queue but picked up by workers later")
        if len(jobs_in_queue) == 0 and len(jobs_pick) == 0:
            info(f"No jobs in queue at time {datetime_str}, skipping mutation to S3")
            return

        key = f"job_queue_times_historical/{repo}/{timestamp}.txt"
        result = jobs_in_queue + jobs_pick
        if self.is_dry_run:
            info(
                f"[Dry Run Mode]: {len(result)} records to S3 {_bucket_name}/{key}"
            )
            print(json.dumps(result))
            return

        upload_to_s3_txt(self.s3_client, _bucket_name, key, result)

    def process_in_queue_jobs(self, queryStr:str, parameters:Any) -> list[dict[str, Any]]:
        """
        post query process to remove duplicated jobs
        this is bc clickhouse client returns duplicated jobs for some reason
        """
        seen = set()
        db_resp  = self.query(queryStr, parameters)
        result = []
        for record in db_resp:
            if record['html_url']in seen:
                continue
            seen.add(record['html_url'])
            result.append(record)
        return result

    def query(self, query, params={}) -> list[dict[str, Any]]:
        reader = self.clickhouse_client.query(query, params)
        # clickhouse returns a generator to return column names and rows
        # see https://clickhouse.com/docs/integrations/python#the-queryresult-object
        column_names = reader.column_names
        rows = reader.result_rows
        res = self._to_query_result_dict(rows, column_names)
        return res

    def _to_query_result_dict(
        self, rows: list[Any], column_names: list[str]
    ) -> list[dict[str, Any]]:
        li = []
        for row in rows:
            record = {}
            for idx, name in enumerate(column_names):
                record[name] = row[idx]
            li.append(record)
        return li


def lambda_handler(event: Any, context: Any) -> None:
    """
    Main method to run in aws lambda environment
    """
    db_client = get_clickhouse_client_environment()
    s3_client = get_aws_s3_resource()

    QueueTimeProcessor(db_client, s3_client).process()

    return


def parse_args() -> argparse.Namespace:
    """
    Parse command line arguments, this is mainly used for local test environment.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--clickhouse-endpoint",
        default=os.getenv("CLICKHOUSE_ENDPOINT", ""),
        type=str,
        help="the clickhouse endpoint, the clickhouse_endpoint name is  https://{clickhouse_endpoint}:{port} for full url ",
    )
    parser.add_argument(
        "--clickhouse-username",
        type=str,
        default=os.getenv("CLICKHOUSE_USERNAME", ""),
        help="the clickhouse username",
    )
    parser.add_argument(
        "--clickhouse-password",
        type=str,
        default=os.getenv("CLICKHOUSE_PASSWORD", ""),
        help="the clickhouse password for the user name",
    )
    parser.add_argument(
        "--not-dry-run",
        action="store_true",
        help="when set, writing results to s3 from local environment. By default, we run in dry-run mode for local environment",
    )
    args, _ = parser.parse_known_args()
    return args


def main() -> None:
    """
    method to run in local test environment
    """

    arguments = parse_args()

    # update environment variables for input parameters
    os.environ["CLICKHOUSE_ENDPOINT"] = arguments.clickhouse_endpoint
    os.environ["CLICKHOUSE_USERNAME"] = arguments.clickhouse_username
    os.environ["CLICKHOUSE_PASSWORD"] = arguments.clickhouse_password

    db_client = get_clickhouse_client_environment()
    s3_client = get_aws_s3_resource()

    # always run in dry-run mode in local environment, unless it's disabled.
    is_dry_run = not arguments.not_dry_run

    QueueTimeProcessor(db_client, s3_client, is_dry_run=is_dry_run).process()

if __name__ == "__main__":
    main()
