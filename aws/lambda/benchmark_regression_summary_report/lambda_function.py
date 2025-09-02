#!/usr/bin/env python
import argparse
import json
import logging
import os
import threading
from collections import defaultdict
from concurrent.futures import as_completed, ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

# Local imports
from typing import Any, Dict, Iterable, List, Optional, Set

import clickhouse_connect
import yaml
from dateutil.parser import parse
from github import Auth, Github


logging.basicConfig(
    level=logging.INFO,
)
logger = logging.getLogger()
logger.setLevel("INFO")

ENVS = {
    "GITHUB_ACCESS_TOKEN": os.getenv("GITHUB_ACCESS_TOKEN", ""),
    "CLICKHOUSE_ENDPOINT": os.getenv("CLICKHOUSE_ENDPOINT", ""),
    "CLICKHOUSE_PASSWORD": os.getenv("CLICKHOUSE_PASSWORD", ""),
    "CLICKHOUSE_USERNAME": os.getenv("CLICKHOUSE_USERNAME", ""),
}


def get_clickhouse_client(
    host: str, user: str, password: str
) -> clickhouse_connect.driver.client.Client:
    # for local testing only, disable SSL verification
    # return clickhouse_connect.get_client(host=host, user=user, password=password,secure=True, verify=False)

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


def is_unix_timestamp(value: str) -> bool:
    """Check if the string is a valid Unix timestamp."""
    if value.isdigit():  # Ensure it's numeric
        try:
            timestamp = int(value)
            # Check if it's within a reasonable range (1970 to 2100)
            datetime.fromtimestamp(timestamp)
            return True
        except (ValueError, OSError):
            return False
    return False


def to_timestap_str(time: datetime) -> str:
    return str(int(time.timestamp()))


def write_to_file(data: Any, filename="", path=""):
    """
    Writes data to a specified file. If no path is provided, writes to the current directory.

    :param data: The content to write to the file.
    :param filename: The name of the file (default: 'output.txt').
    :param path: The directory where the file should be saved (default: current directory).
    """

    if not filename:
        filename = "output_snapshot.json"
    if not path:
        path = "."

    # Ensure the path exists
    os.makedirs(path, exist_ok=True)

    # Construct full file path
    file_path = os.path.join(path, filename)

    # Write data to file
    with open(file_path, "w", encoding="utf-8") as file:
        file.write(data)
    logger.info(f"File written to: {os.path.abspath(file_path)}")



class BenchmarkSummaryProcessor:
    """
    """

    def __init__(
        self,
        is_dry_run: bool = False,
        local_output: bool = False,
        output_snapshot_file_name: str = "summary_report_snapshot",
        output_snapshot_file_path: str = "",
    ) -> None:
        self.is_dry_run = is_dry_run
        self.is_dry_run = is_dry_run
        self.output_snapshot_file_name = output_snapshot_file_name
        self.output_snapshot_file_path = output_snapshot_file_path
        self.local_output = local_output and is_dry_run

    def process(
        self,
        start_time: datetime,
        end_time: datetime,
        cc: Optional[clickhouse_connect.driver.client.Client] = None,
        args: Optional[argparse.Namespace] = None,
    ) -> Dict[str, Any]:
        # ensure each thread has its own clickhouse client. clickhouse client
        # is not thread-safe.
        if cc is None:
            tlocal = threading.local()
            if not hasattr(tlocal, "cc") or tlocal.cc is None:
                if args:
                    tlocal.cc = get_clickhouse_client(
                        args.clickhouse_endpoint,
                        args.clickhouse_username,
                        args.clickhouse_password,
                    )
                else:
                    tlocal.cc = get_clickhouse_client_environment()
            cc = tlocal.cc

        # fetches config to get time series from api


        
        queued_jobs = self._fetch_snapshot_from_db(cc, start_time, end_time, repo)

        if len(queued_jobs) == 0:
            logger.info(
                f" [QueueTimeProcessor][Snapshot {to_timestap_str(end_time)}] "
                + f"No jobs in queue in time range: [{start_time},{end_time}]"
            )

        # add runner labels to each job based on machine type
        self._add_runner_labels(
            queued_jobs,
            start_time,
            meta_runner_config_retriever,
            lf_runner_config_retriever,
            old_lf_lf_runner_config_retriever,
        )

        if len(queued_jobs) == 0:
            logger.info(
                f" [QueueTimeProcessor][Snapshot {to_timestap_str(end_time)}] "
                + "No queued jobs, skipping generating histogram records.."
            )

        records = QueuedJobHistogramGenerator().generate_histogram_records(
            queued_jobs,
            datetime.now(timezone.utc),
            "half-hour-mark-queue-time-histogram",
            end_time,
        )

        if len(records) == 0:
            logger.info(
                f" [QueueTimeProcessor][Snapshot {to_timestap_str(end_time)}] "
                + "No histogram records, skipping writing.."
            )

        if self.is_dry_run:
            logger.info(
                f" [Dry Run Mode][Snapshot {to_timestap_str(end_time)}] "
                + "Writing results to terminal/local file ..."
            )
            self._output_record(queued_jobs, end_time, type="queued_jobs")
            self._output_record(records, end_time, type="records")
            logger.info(
                f" [Dry Run Mode][Snapshot {to_timestap_str(end_time)}] "
                + "Done. Write results to terminal/local file ."
            )
        else:
            self._write_to_db_table(cc, records)

        return {
            "start_time": to_timestap_str(start_time),
            "end_time": to_timestap_str(end_time),
            "jobs_count": len(queued_jobs),
            "records_count": len(records),
        }


class WorkerPoolHandler:
    """
    WorkerPoolHandler runs workers in parallel to generate benchmark regression report
    and writes the results to the target destination.

    """

    def __init__(
        self,
        benchmark_summary_processor: BenchmarkSummaryProcessor,
        max_workers: int = 4,
    ):
        self.benchmark_summary_processor = benchmark_summary_processor
        self.max_workers = max_workers

    def start(
        self,
        config: Dict[str, Any],
        args: Optional[argparse.Namespace] = None,
    ) -> None:
        logger.info(
            "[WorkerPoolHandler] start to process benchmark summary data with config %s", config["name"]
        )
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = []
            for interval in time_intervals:
                future = executor.submit(
                    self.benchmark_summary_processor.process,
                    config,
                    cc=None,
                    args=args,
                )
                futures.append(future)
        results = []
        errors = []

        # handle results from parallel processing
        for future in as_completed(futures):
            try:
                result = future.result()
                # This will raise an exception if one occurred
                results.append(result)
            except Exception as e:
                logger.warning(f"Error processing future: {e}")
                errors.append({"error": str(e)})

def main(
    args: Optional[argparse.Namespace] = None,
    github_access_token: str = "",
    is_dry_run: bool = False,
    local_output: bool = False,
    output_snapshot_file_name: str = "job_queue_times_snapshot",
    output_snapshot_file_path: str = "",
):
    """
    Main method to run in both local environment and lambda handler.
       1. generate intervals[start_time,end_time] using latest timestamp from source table and target table
       2. call WorkerPoolHandler to geneterate and write histogram data for each interval in parallel
    """
    # gets config retrievers, this is used to generate runner labels for histgram
    if not github_access_token:
        raise ValueError("Missing environment variable GITHUB_ACCESS_TOKEN")
    config_retrievers = get_config_retrievers(github_access_token)

    # get time intervals.
    logger.info(" [Main] generating time intervals ....")
    if args:
        cc = get_clickhouse_client(
            args.clickhouse_endpoint, args.clickhouse_username, args.clickhouse_password
        )
    else:
        cc = get_clickhouse_client_environment()
    time_intervals = TimeIntervalGenerator().generate(cc)


    # get jobs in queue from clickhouse for list of time intervals, in parallel
    handler = WorkerPoolHandler(
        config_retrievers,
        BenchmarkSummaryProcessor(
            is_dry_run=is_dry_run,
            local_output=local_output,
            output_snapshot_file_name=output_snapshot_file_name,
            output_snapshot_file_path=output_snapshot_file_path,
        ),
    )
    handler.start(time_intervals, args)
    logger.info(" [Main] Done. work completed.")


def lambda_handler(event: Any, context: Any) -> None:
    """
    Main method to run in aws lambda environment
    """
    main(
        None,
        github_access_token=ENVS["GITHUB_ACCESS_TOKEN"],
    )
    return


def parse_args() -> argparse.Namespace:
    """
    Parse command line args, this is mainly used for local test environment.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--clickhouse-endpoint",
        default=ENVS["CLICKHOUSE_ENDPOINT"],
        type=str,
        help="the clickhouse endpoint, the clickhouse_endpoint "
        + "name is  https://{clickhouse_endpoint}:{port} for full url ",
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
        "--github-access-token",
        type=str,
        default=ENVS["GITHUB_ACCESS_TOKEN"],
        help="the github access token to access github api",
    )
    parser.add_argument(
        "--local-output",
        action="store_true",
        help="when set, generate json result in local environment. "
        + "this is only used for local test environment when dry-run is enabled",
    )
    parser.add_argument(
        "--not-dry-run",
        action="store_true",
        help="when set, writing results to destination from local "
        + "environment. By default, we run in dry-run mode for local "
        + "environment",
    )
    parser.add_argument(
        "--output-file-name",
        type=str,
        default="job_queue_times_snapshot.json",
        help="the name of output file for local environment. this "
        + "is only used for local test environment when local-output is enabled",
    )
    parser.add_argument(
        "--output-file-path",
        type=str,
        default="",
        help="the path of output file for local environment. this is "
        + "only used for local test environment when local-output is enabled",
    )
    args, _ = parser.parse_known_args()
    return args


def local_run() -> None:
    """
    method to run in local test environment
    """

    args = parse_args()

    # update environment variables for input parameters

    # always run in dry-run mode in local environment, unless it's disabled.
    is_dry_run = not args.not_dry_run

    main(
        args,
        args.github_access_token,
        is_dry_run=is_dry_run,
        local_output=args.local_output,
        output_snapshot_file_name=args.output_file_name,
        output_snapshot_file_path=args.output_file_path,
    )


if __name__ == "__main__":
    local_run()
