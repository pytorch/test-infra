#!/usr/bin/env python
import argparse
import datetime as dt
import logging
import os
import threading
import time
from typing import Any, Optional

import clickhouse_connect
import requests
from common.benchmark_time_series_api_model import BenchmarkTimeSeriesApiResponse
from common.config import get_benchmark_regression_config
from common.config_model import BenchmarkApiSource, BenchmarkConfig, Frequency
from common.regression_utils import BenchmarkRegressionReportGenerator
from common.report_manager import ReportManager
from dateutil.parser import isoparse


# TODO(elainewy): change this to benchmark.benchmark_regression_report once the table is created
BENCHMARK_REGRESSION_REPORT_TABLE = "fortesting.benchmark_regression_report"
BENCHMARK_REGRESSION_TRACKING_CONFIG_IDS = ["compiler_regression"]

logging.basicConfig(
    level=logging.INFO,
)
logger = logging.getLogger()
logger.setLevel("INFO")

ENVS = {
    "GITHUB_TOKEN": os.getenv("GITHUB_TOKEN", ""),
    "CLICKHOUSE_ENDPOINT": os.getenv("CLICKHOUSE_ENDPOINT", ""),
    "CLICKHOUSE_PASSWORD": os.getenv("CLICKHOUSE_PASSWORD", ""),
    "CLICKHOUSE_USERNAME": os.getenv("CLICKHOUSE_USERNAME", ""),
}


def format_ts_with_t(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S"
    )


def truncate_to_hour(ts: dt.datetime) -> dt.datetime:
    return ts.replace(minute=0, second=0, microsecond=0)


def get_clickhouse_client(
    host: str, user: str, password: str
) -> clickhouse_connect.driver.client.Client:
    # for local testing only, disable SSL verification
    # return clickhouse_connect.get_client(host=host, user=user, password=password, secure=True, verify=False)
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


class BenchmarkSummaryProcessor:
    def __init__(
        self,
        config_id: str,
        end_time: int,
        is_dry_run: bool = False,
        is_pass_check: bool = False,
    ) -> None:
        self.is_dry_run = is_dry_run
        self.is_pass_check = is_pass_check
        self.config_id = config_id
        self.end_time = end_time

    def log_info(self, msg: str):
        logger.info("[%s][%s] %s", self.end_time, self.config_id, msg)

    def log_error(self, msg: str):
        logger.error("[%s][%s] %s", self.end_time, self.config_id, msg)

    def process(
        self,
        cc: Optional[clickhouse_connect.driver.client.Client] = None,
        args: Optional[argparse.Namespace] = None,
    ):
        # ensure each thread has its own clickhouse client. clickhouse client
        # is not thread-safe.
        self.log_info("start process, getting clickhouse client")
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
        self.log_info("done. got clickhouse client")
        try:
            config = get_benchmark_regression_config(self.config_id)
            self.log_info(f"found config with config_id: `{self.config_id}`")
        except ValueError as e:
            self.log_error(f"Skip process, Invalid config: {e}")
            return
        except Exception as e:
            self.log_error(
                f"Unexpected error from get_benchmark_regression_config: {e}"
            )
            return

        # check if the current time is > policy's time_delta + previous record_ts from summary_table
        report_freq = config.policy.frequency

        should_generate = self._should_generate_report(
            cc, self.end_time, self.config_id, report_freq
        )

        if not should_generate:
            self.log_info(
                "Skip generate report",
            )
            return
        else:
            self.log_info(
                f"Plan to generate report for time: {format_ts_with_t(self.end_time)} "
                f"with frequency {report_freq.get_text()}..."
            )

        target, ls, le = self.get_target(config, self.end_time)
        if not target:
            self.log_info(
                f"no target data found for time range [{ls},{le}] with frequency {report_freq.get_text()}..."
            )
            return
        baseline, bs, be = self.get_baseline(config, self.end_time)
        if not baseline:
            self.log_info(
                f"no baseline data found for time range [{bs},{be}] with frequency {report_freq.get_text()}..."
            )
            return
        generator = BenchmarkRegressionReportGenerator(
            config=config, target_ts=target, baseline_ts=baseline
        )
        regression_report = generator.generate()
        # debugging only
        # if self.is_dry_run:
        #    print(json.dumps(regression_report, indent=2, default=str))
        reportManager = ReportManager(
            config=config,
            regression_report=regression_report,
            db_table_name=BENCHMARK_REGRESSION_REPORT_TABLE,
            is_dry_run=self.is_dry_run,
        )
        reportManager.run(cc, ENVS["GITHUB_TOKEN"])
        return

    def get_target(self, config: BenchmarkConfig, end_time: int):
        data_range = config.policy.range
        target_s = end_time - data_range.comparison_timedelta_s()
        target_e = end_time
        self.log_info(
            "getting target data (newest) for time range "
            f"[{format_ts_with_t(target_s)},{format_ts_with_t(target_e)}] ..."
        )
        target_data = self._fetch_from_benchmark_ts_api(
            config_id=config.id,
            start_time=target_s,
            end_time=target_e,
            source=config.source,
        )
        self.log_info(
            f"done fetching target data (newest). found {len(target_data.time_series)} # of groups, with time range {target_data.time_range}",
        )
        if not target_data.time_range or not target_data.time_range.end:
            return None, target_s, target_e

        target_ts = int(isoparse(target_data.time_range.end).timestamp())
        if not self.should_use_data(target_ts, end_time):
            return None, target_s, target_e
        return target_data, target_s, target_e

    def get_baseline(self, config: BenchmarkConfig, end_time: int):
        data_range = config.policy.range
        baseline_s = end_time - data_range.total_timedelta_s()
        baseline_e = end_time - data_range.comparison_timedelta_s()
        self.log_info(
            "getting baseline data for time range "
            f"[{format_ts_with_t(baseline_s)},{format_ts_with_t(baseline_e)}] ..."
        )
        # fetch baseline from api
        raw_data = self._fetch_from_benchmark_ts_api(
            config_id=config.id,
            start_time=baseline_s,
            end_time=baseline_e,
            source=config.source,
        )

        self.log_info(
            f"Done. found {len(raw_data.time_series)} # of data, with time range {raw_data.time_range}",
        )

        baseline_latest_ts = int(isoparse(raw_data.time_range.end).timestamp())

        if not self.should_use_data(baseline_latest_ts, baseline_e):
            self.log_info(
                "[get_basline] Skip generate report, no data found during "
                f"[{format_ts_with_t(baseline_s)},{format_ts_with_t(baseline_e)}]"
            )
            return None, baseline_s, baseline_e
        return raw_data, baseline_s, baseline_e

    def should_use_data(
        self,
        latest_ts: int,
        end_time: int,
        min_delta: Optional[dt.timedelta] = None,
    ) -> bool:
        # set default
        if not min_delta:
            min_delta = dt.timedelta(days=2)

        if not latest_ts:
            return False

        cutoff = end_time - min_delta.total_seconds()

        if latest_ts >= cutoff:
            return True
        self.log_info(f"expect latest data to be after unixtime {cutoff}, but got {latest_ts}")
        return False

    def _fetch_from_benchmark_ts_api(
        self,
        config_id: str,
        end_time: int,
        start_time: int,
        source: BenchmarkApiSource,
    ):
        str_end_time = format_ts_with_t(end_time)
        str_start_time = format_ts_with_t(start_time)
        query = source.render(
            ctx={
                "startTime": str_start_time,
                "stopTime": str_end_time,
            }
        )
        url = source.api_query_url

        self.log_info(f"trying to call {url}")
        t0 = time.perf_counter()
        try:
            resp: BenchmarkTimeSeriesApiResponse = (
                BenchmarkTimeSeriesApiResponse.from_request(url, query)
            )

            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            self.log_info(
                f"call OK in {elapsed_ms} ms (query_len={len(query)})",
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
            self.log_error(
                f"call FAILED in {elapsed_ms} ms: {err_msg}",
            )
            raise

        except Exception as e:
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            self.log_error(f"call CRASHED in {elapsed_ms} ms: {e}")
            raise RuntimeError(f"[{config_id}]Fetch failed: {e}")

    def _should_generate_report(
        self,
        cc: clickhouse_connect.driver.client.Client,
        end_time: int,
        config_id: str,
        f: Frequency,
    ) -> bool:
        def _get_latest_record_ts(
            cc: clickhouse_connect.driver.Client,
            config_id: str,
        ) -> Optional[int]:
            table = BENCHMARK_REGRESSION_REPORT_TABLE
            res = cc.query(
                f"""
                SELECT toUnixTimestamp(max(last_record_ts))
                FROM {table}
                WHERE report_id = {{config_id:String}}
                """,
                parameters={"config_id": config_id},
            )

            if not res.result_rows or res.result_rows[0][0] is None:
                return None
            return int(res.result_rows[0][0])

        freq_delta = f.to_timedelta_s()
        latest_record_ts = _get_latest_record_ts(cc, config_id)
        # No report exists yet, generate
        if not latest_record_ts:
            self.log_info(
                f"no latest record ts from db for the config_id, got {latest_record_ts}"
            )
            return True
        self.log_info(f"found latest record ts from db {latest_record_ts}")
        time_boundary = latest_record_ts + freq_delta
        should_generate = end_time > time_boundary

        if not should_generate:
            self.log_info(
                f"[{f.get_text()}] skip generate report. end_time({format_ts_with_t(end_time)})"
                f" must greater than time_boundary({format_ts_with_t(time_boundary)})"
                f"based on latest_record_ts({format_ts_with_t(latest_record_ts)})",
            )
        else:
            self.log_info(
                f"[{f.get_text()}]plan to generate report. end_time({format_ts_with_t(end_time)}) is greater than "
                f"time_boundary({format_ts_with_t(time_boundary)})"
                f"based on latest_record_ts({format_ts_with_t(latest_record_ts)})",
            )
        # dry_run is True, is_pass_check is True, then we allow to generate report even the time check is not met
        if self.is_dry_run and self.is_pass_check:
            should_generate = True
            self.log_info(
                f"[{f.get_text()}] dry_run is True, is_pass_check is True, force generate report for print only",
            )
        return should_generate


def main(
    config_id: str,
    github_access_token: str = "",
    args: Optional[argparse.Namespace] = None,
    *,
    is_dry_run: bool = False,
    is_forced: bool = False,
):
    if not is_dry_run and is_forced:
        is_forced = False
        logger.info("is_dry_run is False, force  must be disabled, this is not allowed")

    if not github_access_token:
        raise ValueError("Missing environment variable GITHUB_TOKEN")

    if not config_id:
        raise ValueError("Missing required parameter: config_id")

    end_time = dt.datetime.now(dt.timezone.utc).replace(
        minute=0, second=0, microsecond=0
    )
    end_time_ts = int(end_time.timestamp())
    logger.info(
        "[Main] current time with hour granularity(utc) %s with unix timestamp %s",
        end_time,
        end_time_ts,
    )
    logger.info("[Main] start work ....")

    # caution, raise exception may lead lambda to retry
    try:
        processor = BenchmarkSummaryProcessor(
            config_id=config_id,
            end_time=end_time_ts,
            is_dry_run=is_dry_run,
            is_pass_check=is_forced,
        )
        processor.process(args=args)
    except Exception as e:
        logger.error(f"[Main] failed to process config_id {config_id}, error: {e}")
        raise
    logger.info(" [Main] Done. work completed.")


def lambda_handler(event: Any, context: Any) -> None:
    """
    Main method to run in aws lambda environment
    """
    config_id = event.get("config_id")
    if not config_id:
        raise ValueError("Missing required parameter: config_id")

    main(
        config_id=config_id,
        github_access_token=ENVS["GITHUB_TOKEN"],
    )
    return


def parse_args() -> argparse.Namespace:
    """
    Parse command line args, this is mainly used for local test environment.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dry-run",
        dest="dry_run",
        action="store_true",
        help="Enable dry-run mode",
    )
    parser.add_argument(
        "--no-dry-run",
        dest="dry_run",
        action="store_false",
        help="Disable dry-run mode",
    )
    parser.add_argument(
        "--force",
        dest="force",
        action="store_true",
        help="Enable force mode, this only allowed when dry-run is enabled",
    )
    parser.add_argument(
        "--config-id",
        type=str,
        help="the config id to run",
    )
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
        default=ENVS["GITHUB_TOKEN"],
        help="the github access token to access github api",
    )
    parser.set_defaults(dry_run=True)  # default is True
    args, _ = parser.parse_known_args()
    return args


def local_run() -> None:
    """
    method to run in local test environment
    """

    args = parse_args()
    # update environment variables for input parameters
    main(
        config_id=args.config_id,
        github_access_token=args.github_access_token,
        args=args,
        is_dry_run=args.dry_run,
        is_forced=args.force,
    )


if __name__ == "__main__":
    local_run()
