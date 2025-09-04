#!/usr/bin/env python
import argparse
import datetime as dt
import logging
import os
import threading
import time
from concurrent.futures import as_completed, ThreadPoolExecutor
from typing import Any, Optional

import clickhouse_connect
import requests
from common.benchmark_time_series_api_model import BenchmarkTimeSeriesApiResponse
from common.config import get_benchmark_regression_config
from common.config_model import BenchmarkApiSource, BenchmarkConfig, Frequency
from common.regression_utils import BenchmarkRegressionReportGenerator
from dateutil.parser import isoparse


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

# TODO(elainewy): change this to benchmark.benchmark_regression_report once the table is created
BENCHMARK_REGRESSION_REPORT_TABLE = "fortesting.benchmark_regression_report"
BENCHMARK_REGRESSION_TRACKING_CONFIG_IDS = ["compiler_regression"]


def truncate_to_hour(ts: dt.datetime) -> dt.datetime:
    return ts.replace(minute=0, second=0, microsecond=0)


def get_clickhouse_client(
    host: str, user: str, password: str
) -> clickhouse_connect.driver.client.Client:
    # for local testing only, disable SSL verification
    return clickhouse_connect.get_client( host=host, user=user, password=password, secure=True, verify=False)

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


BENCHMARK_REGRESSION_SUMMARY_REPORT_TABLE = (
    "fortesting.benchmark_regression_summary_report"
)


class BenchmarkSummaryProcessor:
    def __init__(
        self,
        is_dry_run: bool = False,
    ) -> None:
        self.is_dry_run = is_dry_run

    def process(
        self,
        config_id: str,
        end_time: dt.datetime,
        cc: Optional[clickhouse_connect.driver.client.Client] = None,
        args: Optional[argparse.Namespace] = None,
    ):
        def log_info(msg: str):
            logger.info("[%s] %s", config_id, msg)

        def log_error(msg: str):
            logger.error("[%s] %s", config_id, msg)

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
        try:
            config = get_benchmark_regression_config(config_id)
            log_info(f"found config for config_id {config_id}")
        except ValueError as e:
            log_error(f"Skip process, Invalid config: {e}")
            return
        except Exception as e:
            log_error(f"Unexpected error from get_benchmark_regression_config: {e}")
            return

        # check if the current time is > policy's time_delta + previous record_ts from summary_table
        report_freq = config.policy.frequency
        should_generate = self._should_generate_report(
            cc, end_time, config_id, report_freq
        )
        if not should_generate:
            log_info(
                f"Skip generate report for time:{end_time} with frequency {report_freq.get_text()}, no data found",
            )
            return
        else:
            log_info(
                f"Plan to generate report for time:{end_time} with frequency {report_freq.get_text()}..."
            )
        latest, ls, le = self.get_latest(config, end_time)
        if not latest:
            log_info(
                f"no latest data found for time range [{ls},{le}] with frequency {report_freq.get_text()}..."
            )
            return

        baseline, bs, be = self.get_baseline(config, end_time)
        if not baseline:
            log_info(
                f"no baseline data found for time range [{bs},{be}] with frequency {report_freq.get_text()}..."
            )
            return
        generator = BenchmarkRegressionReportGenerator(
            config=config, latest_ts=latest, baseline_ts=baseline
        )

        result, regression_summary = generator.generate()
        if self.is_dry_run:
            print("regression_detected: ", regression_summary)
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
        logger.info(
            "[%s] found %s # of data, with time range %s",
            config.id,
            len(latest_data.time_series),
            latest_data.time_range,
        )
        if not latest_data.time_range or not latest_data.time_range.end:
            return None, latest_s, latest_e
        if not self.should_use_data(config.id, latest_data.time_range.end, end_time):
            return None, latest_s, latest_e
        return latest_data, latest_s, latest_e

    def get_baseline(self, config: BenchmarkConfig, end_time: dt.datetime):
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

        logger.info(
            "found %s # of data, with time range %s",
            len(raw_data.time_series),
            raw_data.time_range,
        )
        if not self.should_use_data(config.id, raw_data.time_range.end, baseline_e):
            logger.info(
                "[%s][get_basline] Skip generate report, no data found during [%s,%s]",
                config.id,
                baseline_s.isoformat(),
                baseline_e.isoformat(),
            )
            return None, baseline_s, baseline_e
        return raw_data, baseline_s, baseline_e

    def should_use_data(
        self,
        config_id: str,
        latest_ts_str: str,
        end_time: dt.datetime,
        min_delta: Optional[dt.timedelta] = None,
    ) -> bool:
        # set default
        if not min_delta:
            min_delta = dt.timedelta(days=2)

        if not latest_ts_str:
            return False
        latest_dt = isoparse(latest_ts_str)
        cutoff = end_time - min_delta

        if latest_dt >= cutoff:
            return True
        logger.info(
            "[%s] expect latest data to be after %s, but got %s",
            config_id,
            cutoff,
            latest_dt,
        )
        return False

    def _fetch_from_benchmark_ts_api(
        self,
        config_id: str,
        end_time: dt.datetime,
        start_time: dt.datetime,
        source: BenchmarkApiSource,
    ):
        str_end_time = end_time.strftime("%Y-%m-%dT%H:%M:%S")
        str_start_time = start_time.strftime("%Y-%m-%dT%H:%M:%S")
        query = source.render(
            ctx={
                "startTime": str_start_time,
                "stopTime": str_end_time,
            }
        )
        url = source.api_query_url

        logger.info("[%s]trying to call %s", config_id, url)
        t0 = time.perf_counter()
        try:
            resp: BenchmarkTimeSeriesApiResponse = (
                BenchmarkTimeSeriesApiResponse.from_request(url, query)
            )

            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            logger.info(
                "[%s] call OK in %.1f ms (query_len=%d)",
                config_id,
                elapsed_ms,
                len(query),
            )
            return resp.data
        except requests.exceptions.HTTPError as e:
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            # Try to extract a useful server message safely
            try:
                err_msg = (
                    e.response.json().get("error") if e.response is not None else str(e)
                )
            except Exception:
                err_msg = (
                    e.response.text
                    if (e.response is not None and hasattr(e.response, "text"))
                    else str(e)
                )
            logger.error(
                "[%s] call FAILED in %.1f ms: %s", config_id, elapsed_ms, err_msg
            )
            raise

        except Exception as e:
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            logger.error("[%s] call CRASHED in %.1f ms", config_id, elapsed_ms)
            raise RuntimeError(f"[{config_id}]Fetch failed: {e}")

    def _should_generate_report(
        self,
        cc: clickhouse_connect.driver.client.Client,
        end_time: dt.datetime,
        config_id: str,
        f: Frequency,
    ) -> bool:
        def _get_latest_record_ts(
            cc: clickhouse_connect.driver.Client,
            config_id: str,
        ) -> Optional[dt.datetime]:
            table = BENCHMARK_REGRESSION_REPORT_TABLE
            res = cc.query(
                f"""
                SELECT max(last_record_ts)
                FROM {table}
                WHERE report_id = {{config_id:String}}
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


class WorkerPoolHandler:
    """
    WorkerPoolHandler runs workers in parallel to generate benchmark regression report
    and writes the results to the target destination.

    """

    def __init__(
        self,
        benchmark_summary_processor: BenchmarkSummaryProcessor,
        max_workers: int = 6,
    ):
        self.benchmark_summary_processor = benchmark_summary_processor
        self.max_workers = max_workers

    def start(
        self,
        config_ids: list[str],
        args: Optional[argparse.Namespace] = None,
    ) -> None:
        logger.info(
            "[WorkerPoolHandler] start to process benchmark "
            "summary data with required config: %s",
            config_ids,
        )
        end_time = dt.datetime.now(dt.timezone.utc).replace(
            minute=0, second=0, microsecond=0
        )
        logger.info("current time with hour granularity(utc) %s", end_time)
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = []
            for config_id in config_ids:
                future = executor.submit(
                    self.benchmark_summary_processor.process,
                    config_id,
                    end_time,
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
    logger.info("[Main] start work ....")

    # get jobs in queue from clickhouse for list of time intervals, in parallel
    handler = WorkerPoolHandler(
        BenchmarkSummaryProcessor(is_dry_run=is_dry_run),
    )
    handler.start(BENCHMARK_REGRESSION_TRACKING_CONFIG_IDS, args)
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
        "--not-dry-run",
        action="store_true",
        help="when set, writing results to destination from local "
        + "environment. By default, we run in dry-run mode for local "
        + "environment",
    )
    args, _ = parser.parse_known_args()
    return args


def local_run() -> None:
    """
    method to run in local test environment
    """

    args = parse_args()

    logger.info("args: %s", args)

    # update environment variables for input parameters

    # always run in dry-run mode in local environment, unless it's disabled.
    is_dry_run = not args.not_dry_run

    main(
        args,
        args.github_access_token,
        is_dry_run=is_dry_run,
    )


if __name__ == "__main__":
    local_run()
