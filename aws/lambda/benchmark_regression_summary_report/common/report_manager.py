import dataclasses
import datetime as dt
import json
import logging
import uuid
from typing import Any, Dict

import clickhouse_connect
from common.config_model import BenchmarkConfig, Frequency
from common.regression_utils import (
    BenchmarkRegressionReport,
    get_regression_status,
    PerGroupResult,
)


logger = logging.getLogger()


class ReportManager:
    """
    handles db insertion and notification processing
    Currently, it only supports clickhouse as db and github as notification channel (via github api)
    """

    def __init__(
        self,
        db_table_name: str,
        config: BenchmarkConfig,
        regression_report: BenchmarkRegressionReport,
        type: str = "general",
        repo: str = "pytorch/pytorch",
        is_dry_run: bool = False,
    ):
        self.is_dry_run = is_dry_run

        self.report = regression_report
        self.config_id = config.id
        self.config = config

        self.type = type
        self.repo = repo
        self.db_table_name = db_table_name

        self.id = str(uuid.uuid4())

        # extract latest meta data from report
        self.baseline = self.report["baseline_meta_data"]
        self.target = self.report["new_meta_data"]
        self.target_latest_commit = self.target["end"]["commit"]
        self.target_latest_ts_str = self.target["end"]["timestamp"]
        self.status = get_regression_status(self.report["summary"])

        self.report_data = self._to_report_data(
            config_id=config.id,
            regression_report=self.report,
            frequency=self.config.policy.frequency,
        )

    def run(
        self, cc: clickhouse_connect.driver.client.Client, github_token: str
    ) -> None:
        """
        main method used to insert the report to db and create github comment in targeted issue
        """
        try:
            self.insert_to_db(cc)
        except Exception as e:
            logger.error(f"failed to insert report to db, error: {e}")
            raise

    def _collect_regression_items(self) -> list[PerGroupResult]:
        items = []
        for item in self.report["results"]:
            if item["label"] == "regression":
                items.append(item)
        return items

    def insert_to_db(
        self,
        cc: clickhouse_connect.driver.client.Client,
    ) -> None:
        logger.info(
            "[%s]prepare data for db insertion report (%s)...", self.config_id, self.id
        )
        latest_ts_str = self.target_latest_ts_str
        if not latest_ts_str:
            raise ValueError(
                f"timestamp from latest is required, latest is {self.target}"
            )
        aware = dt.datetime.fromisoformat(latest_ts_str.replace("Z", "+00:00"))
        utc_naive = aware.astimezone(dt.timezone.utc).replace(tzinfo=None)
        last_record_ts = utc_naive.strftime("%Y-%m-%d %H:%M:%S")

        try:
            report_json = json.dumps(
                self.report, ensure_ascii=False, separators=(",", ":"), default=str
            )
        except Exception:
            logger.exception(
                "[%s] failed to serialize report data to json",
                self.config_id,
            )
            raise

        regression_summary = self.report["summary"]
        params = {
            "id": str(self.id),
            "report_id": self.config_id,
            "type": self.type,
            "status": get_regression_status(self.report["summary"]),
            "last_record_commit": self.target_latest_commit,
            "last_record_ts": last_record_ts,
            "regression_count": regression_summary["regression_count"],
            "insufficient_data_count": int(
                regression_summary["insufficient_data_count"]
            ),
            "suspected_regression_count": regression_summary["suspicious_count"],
            "total_count": regression_summary["total_count"],
            "repo": self.repo,
            "report_json": report_json,
        }
        logger.info(
            "[%s]inserting benchmark regression report(%s)", self.config_id, self.id
        )
        self._db_insert(cc, self.db_table_name, params)

        logger.info(
            "[%s] Done. inserted benchmark regression report(%s)",
            self.config_id,
            self.id,
        )

    def _db_insert(
        self,
        cc: clickhouse_connect.driver.Client,
        table: str,
        params: dict,
    ) -> tuple[bool, int]:
        sql = f"""
            INSERT INTO {table} (
                id,
                report_id,
                last_record_ts,
                last_record_commit,
                `type`,
                status,
                regression_count,
                insufficient_data_count,
                suspected_regression_count,
                total_count,
                repo,
                report
            )
            SELECT
                {{id:UUID}},
                {{report_id:String}},
                {{last_record_ts:DateTime64(0)}},
                {{last_record_commit:String}},
                {{type:String}},
                {{status:String}},
                {{regression_count:UInt32}},
                {{insufficient_data_count:UInt32}},
                {{suspected_regression_count:UInt32}},
                {{total_count:UInt32}},
                {{repo:String}},
                {{report_json:String}}
            FROM system.one
            WHERE NOT EXISTS (
                SELECT 1
                FROM {table}
                WHERE report_id = {{report_id:String}}
                AND `type`    = {{type:String}}
                AND repo      = {{repo:String}}
                AND stamp     = toDate({{last_record_ts:DateTime64(0)}})
            )
            LIMIT 1
        """

        res = cc.query(sql, parameters=params)
        summary = getattr(res, "summary", {}) or {}

        written_any = (
            summary.get("written_rows")
            or summary.get("rows_written")
            or summary.get("written", 0)
            or 0
        )

        logger.info("wrting to db summmary %s", summary)
        try:
            written = int(written_any)
        except (TypeError, ValueError):
            written = 0

        inserted = written > 0
        return inserted, written

    def _validate_latest_meta_info(
        self, latest_meta_info: Dict[str, Any]
    ) -> Dict[str, Any]:
        latest_commit = latest_meta_info.get("commit")
        if not latest_commit:
            raise ValueError(
                f"missing commit from latest is required, latest is {latest_meta_info}"
            )
        lastest_ts_str = latest_meta_info.get("timestamp")
        if not lastest_ts_str:
            raise ValueError(
                f"timestamp from latest is required, latest is {latest_meta_info}"
            )
        return latest_meta_info

    def _to_report_data(
        self,
        config_id: str,
        regression_report: BenchmarkRegressionReport,
        frequency: Frequency,
    ) -> dict[str, Any]:
        if not self.target_latest_commit:
            raise ValueError(
                f"missing commit from new is required, latest is {self.target}"
            )
        lastest_ts_str = self.target_latest_ts_str
        if not lastest_ts_str:
            raise ValueError(f"timestamp from new is required, latest is {self.target}")

        def to_dict(x):  # handle dataclass or dict/object
            if dataclasses.is_dataclass(x):
                return dataclasses.asdict(x)
            if isinstance(x, dict):
                return x
            return vars(x) if hasattr(x, "__dict__") else {"value": str(x)}

        report = to_dict(regression_report)
        return {
            "status": self.status,
            "report_id": config_id,
            "report": report,
            "frequency": frequency.get_text(),
        }
