#!/usr/bin/env python
import argparse
import json
import logging
import os
import threading
from concurrent.futures import as_completed, ThreadPoolExecutor
import datetime as dt
from typing import Optional
from common.regression_utils import BenchmarkRegressionReportGenerator
import clickhouse_connect
from common.benchmark_time_series_api_model import (
    BenchmarkTimeSeriesApiResponse,
)
from common.config_model import (
    BenchmarkApiSource,
    BenchmarkConfig,
    Frequency,
)
from common.config import BENCHMARK_REGRESSION_CONFIG
from dateutil.parser import isoparse

from pprint import pprint

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

BENMARK_REGRESSION_REPORT_DB = "fortesting.benchmark_regression_report"


def truncate_to_hour(ts: dt.datetime) -> dt.datetime:
    return ts.replace(minute=0, second=0, microsecond=0)


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

BENCHMARK_REGRESSION_SUMMARY_REPORT_TABLE = "benchmark_regression_summary_report"

def get_config(config_id: str) -> BenchmarkConfig:
    try:
        config: BenchmarkConfig = BENCHMARK_REGRESSION_CONFIG[config_id]
    except KeyError:
        raise ValueError(f"Invalid config id: {config_id}")
    except Exception as e:
        raise e
    return config

class BenchmarkSummaryProcessor:
    """ """

    def __init__(
        self,
        is_dry_run: bool = False,
    ) -> None:
        self.is_dry_run = is_dry_run

    def should_generate_report(
        self,
        cc: clickhouse_connect.driver.client.Client,
        end_time: dt.datetime,
        config_id: str,
        f: Frequency,
    ) -> bool:
        """
        decide wether should generate the report based on the frequency in policy
        """

        def _get_latest_record_ts(
            cc: clickhouse_connect.driver.Client,
            config_id: str,
        ) -> Optional[dt.datetime]:
            res = cc.query(
                """
                SELECT max(last_record_ts)
                FROM benchmark_regression_report
                WHERE report_id = {config_id:String}
                """,
                parameters={"config_id": config_id},
            )
            if not res.result_rows or res.result_rows[0][0] is None:
                return None
            latest: dt.datetime = res.result_rows[0][
                0
            ]  # typically tz-aware UTC from clickhouse_connect
            # If not tz-aware, force UTC:
            if latest.tzinfo is None:
                latest = latest.replace(tzinfo=dt.timezone.utc)
            return latest

        freq_delta = f.to_timedelta()
        latest_record_ts = _get_latest_record_ts(cc, config_id)

        # No report exists yet, generate
        if not latest_record_ts:
            return True

        end_utc = (
            end_time if end_time.tzinfo else end_time.replace(tzinfo=dt.timezone.utc)
        )
        end_utc = end_utc.astimezone(dt.timezone.utc)
        cutoff = end_time - freq_delta
        return latest_record_ts < cutoff

    def process(
        self,
        config_id: str,
        end_time: dt.datetime,
        cc: Optional[clickhouse_connect.driver.client.Client] = None,
        args: Optional[argparse.Namespace] = None,
    ):
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
        config = get_config(config_id)

        # check if the current time is > policy's time_delta + previous record_ts from summary_table
        report_freq = config.policy.frequency
        should_generate = self.should_generate_report(
            cc, end_time, config_id, report_freq
        )
        if not should_generate:
            logger.info(
                "[%s] Skip generate report for date: %s with frequency %s",
                config_id,
                end_time.isoformat(),
                report_freq.get_text(),
            )
            return

        latest = self.get_latest(config, end_time)
        if not latest:
            return
        baseline = self.get_basline(config, end_time)
        if not baseline:
            return

        generator = BenchmarkRegressionReportGenerator(
            config=config, latest_ts=latest, baseline_ts=baseline
        )
        result, regression_detected = generator.generate()
        if self.is_dry_run:
            print("regression_detected: ", regression_detected)
            print(json.dumps(result, indent=2, default=str))
        return

    def get_latest(self, config: BenchmarkConfig, end_time: dt.datetime):
        data_range = config.policy.range
        latest_s = end_time - data_range.comparison_timedelta()
        latest_e = end_time
        latest_data = self._fetch_from_benchmark_ts_api(
            config_id=config.id,
            start_time=latest_s,
            end_time=latest_e,
            source=config.source,
        )
        if not latest_data.time_range or latest_data.time_range.end:
            logger.info(
                "[%s] Skip generate report for date:"
                "%s with frequency %s, no data found during [%s,%s]",
                config.id,
                latest_s.isoformat(),
                latest_e.isoformat(),
            )
            return None

        if not self.should_use_data(latest_data.time_range.end, end_time):
            logger.info(
                "[%s] Skip generate report for date: trying to get_basline"
                " with frequency %s, but no data found during for [%s,%s]",
                config.id,
                config.policy.frequency.get_text(),
                latest_s.isoformat(),
                latest_e.isoformat(),
            )
            return None
        return latest_data

    def get_basline(self, config: BenchmarkConfig, end_time: dt.datetime):
        data_range = config.policy.range
        baseline_s = end_time - data_range.total_timedelta()
        baseline_e = end_time - data_range.comparison_timedelta()
        # fetch baseline from api
        raw_data = self._fetch_from_benchmark_ts_api(
            config_id=config.id,
            start_time=baseline_s,
            end_time=baseline_e,
            source=config.source,
        )
        if not self.should_use_data(raw_data.time_range.end, end_time):
            logger.info(
                "[%s][get_basline] Skip generate report, no data found during [%s,%s]",
                config.id,
                baseline_s.isoformat(),
                baseline_e.isoformat(),
            )
            return None
        return raw_data

    def should_use_data(
        self,
        latest_ts_str: str,
        end_time: dt.datetime,
        min_delta: dt.timedelta = dt.timedelta(days=2),
    ) -> bool:
        if not latest_ts_str:
            return False
        latest_dt = isoparse(latest_ts_str)
        cutoff = end_time - min_delta
        return latest_dt >= cutoff

    def _fetch_from_benchmark_ts_api(
        self,
        config_id: str,
        end_time: dt.datetime,
        start_time: dt.datetime,
        source: BenchmarkApiSource,
    ):
        str_end_time = end_time.isoformat()
        str_start_time = start_time.isoformat()
        query = source.render(
            ctx={
                "startTime": str_start_time,
                "endTime": str_end_time,
            }
        )
        url = source.api_query_url
        try:
            resp: BenchmarkTimeSeriesApiResponse = (
                BenchmarkTimeSeriesApiResponse.from_request(url, query)
            )

            return resp.data
        except Exception as e:
            raise RuntimeError(f"[{config_id}]Fetch failed:", e)


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
            "[WorkerPoolHandler] start to process benchmark summary data with config %s",
            config["name"],
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
):
    """
    Main method to run in both local environment and lambda handler.
       1. generate intervals[start_time,end_time] using latest timestamp from source table and target table
       2. call WorkerPoolHandler to geneterate and write histogram data for each interval in parallel
    """
    if not github_access_token:
        raise ValueError("Missing environment variable GITHUB_ACCESS_TOKEN")

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
        BenchmarkSummaryProcessor(is_dry_run=is_dry_run),
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
