import dataclasses
import datetime as dt
import json
import logging
import uuid
from typing import Any, Dict, List

import clickhouse_connect
from common.config_model import BenchmarkConfig, Frequency
from common.regression_utils import PerGroupResult
from jinja2 import Template


logger = logging.getLogger()


REPORT_MD_TEMPLATE = """# Benchmark Report {{id}}
config_id: `{{ report_id }}`

> **Status:** {{ status }} · **Frequency:** {{ frequency }}

## Latest
- **Timestamp:** `{{ latest.timestamp | default('') }}`
- **Commit:** `{{ (latest.commit | default(''))[:12] }}`
- **Branch:** `{{ latest.branch | default('') }}`
- **Workflow ID:** `{{ latest.workflow_id | default('') }}`

## Summary
| Metric | Value |
| :-- | --: |
| Total | {{ summary.total_count | default(0) }} |
| Regressions | {{ summary.regression_count | default(0) }} |
| Suspicious | {{ summary.suspicious_count | default(0) }} |
| No Regression | {{ summary.no_regression_count | default(0) }} |
| Insufficient Data | {{ summary.insufficient_data_count | default(0) }} |
"""


class ReportManager:
    """
    handles db insertion and notification processing
    """

    def __init__(
        self,
        db_table_name: str,
        config_id: str,
        config: BenchmarkConfig,
        regression_summary: Dict[str, Any],
        latest_meta_info: Dict[str, Any],
        result: List[PerGroupResult],
        type: str = "general",
        repo: str = "pytorch/pytorch",
    ):
        self.regression_summary = regression_summary
        self.regression_result = result
        self.config_id = config_id
        self.config = config
        self.status = self._resolve_status(regression_summary)
        self.latest_meta_info = self._validate_latest_meta_info(latest_meta_info)
        self.report_data = self._to_report_data(
            config_id=config_id,
            summary=self.regression_summary,
            report=self.regression_result,
            latest=self.latest_meta_info,
            status=self.status,
            frequency=self.config.policy.frequency,
        )
        self.type = type
        self.repo = repo
        self.db_table_name = db_table_name
        self.id = str(uuid.uuid4())

    def run(
        self, cc: clickhouse_connect.driver.client.Client, github_token: str
    ) -> None:
        try:
            self.insert_to_db(cc)
        except Exception as e:
            logger.error(f"failed to insert report to db, error: {e}")
            raise
        self.notify_github_comment(github_token)

    def notify_github_comment(self, github_token: str):
        if self.status != "regression":
            logger.info(
                "[%s] no regression found, skip notification",
                self.config_id,
            )
            return

        github_notification = self.config.policy.get_github_notification_config()
        if not github_notification:
            logger.info(
                "[%s] no github notification config found, skip notification",
                self.config_id,
            )
            return
        logger.info("[%s] prepareing content", self.config_id)
        content = self._to_markdoown()
        logger.info("[%s] create comment to github issue", self.config_id)
        github_notification.create_github_comment(content, github_token)
        logger.info("[%s] done. comment is sent to github", self.config_id)

    def _to_markdoown(self):
        md = Template(REPORT_MD_TEMPLATE, trim_blocks=True, lstrip_blocks=True).render(
            id=self.id,
            status=self.status,
            report_id=self.config_id,
            summary=self.regression_summary,
            latest=self.latest_meta_info,
            frequency=self.config.policy.frequency.get_text(),
        )
        return md

    def insert_to_db(
        self,
        cc: clickhouse_connect.driver.client.Client,
    ) -> None:
        logger.info(
            "[%s]prepare data for db insertion report (%s)...", self.config_id, self.id
        )

        table = self.db_table_name

        latest_ts_str = self.latest_meta_info.get("timestamp")
        if not latest_ts_str:
            raise ValueError(
                f"timestamp from latest is required, latest is {self.latest_meta_info}"
            )

        # ---- 转 UTC，并格式成 ClickHouse 友好的 'YYYY-MM-DD HH:MM:SS' ----
        aware = dt.datetime.fromisoformat(latest_ts_str.replace("Z", "+00:00"))
        utc_naive = aware.astimezone(dt.timezone.utc).replace(tzinfo=None)
        last_record_ts = utc_naive.strftime("%Y-%m-%d %H:%M:%S")

        report_json = json.dumps(
            self.report_data, ensure_ascii=False, separators=(",", ":"), default=str
        )

        params = {
            "id": str(self.id),
            "report_id": self.config_id,
            "type": self.type,
            "status": self.status,
            "last_record_commit": self.latest_meta_info.get("commit", ""),
            "last_record_ts": last_record_ts,
            "regression_count": int(self.regression_summary.get("regression_count", 0)),
            "insufficient_data_count": int(
                self.regression_summary.get("insufficient_data_count", 0)
            ),
            "suspected_regression_count": int(
                self.regression_summary.get("suspicious_count", 0)
            ),
            "total_count": int(self.regression_summary.get("total_count", 0)),
            "repo": self.repo,
            "report_json": report_json,
        }

        logger.info(
            "[%s]inserting benchmark regression report(%s)", self.config_id, self.id
        )

        # INSERT ... SELECT ... FROM system.one + NOT EXISTS protection
        cc.query(
            f"""
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
            );
            """,
            parameters=params,
        )

        logger.info(
            "[%s] Done. inserted benchmark regression report(%s)",
            self.config_id,
            self.id,
        )

    def _resolve_status(self, regression_summary: Dict[str, Any]) -> str:
        status = (
            "regression"
            if regression_summary.get("regression_count", 0) > 0
            else "suspicious"
            if regression_summary.get("suspicious_count", 0) > 0
            else "no_regression"
        )
        return status

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
        summary: Dict[str, Any],
        report: List[Any],  # List[PerGroupResult] or dicts
        latest: dict[str, Any],  # {"commit","branch","timestamp","workflow_id"}
        status: str,
        frequency: Frequency,
    ) -> dict[str, Any]:
        latest_commit = latest.get("commit")
        if not latest_commit:
            raise ValueError(
                f"missing commit from latest is required, latest is {latest}"
            )
        lastest_ts_str = latest.get("timestamp")
        if not lastest_ts_str:
            raise ValueError(f"timestamp from latest is required, latest is {latest}")

        def to_dict(x):  # handle dataclass or dict/object
            if dataclasses.is_dataclass(x):
                return dataclasses.asdict(x)
            if isinstance(x, dict):
                return x
            return vars(x) if hasattr(x, "__dict__") else {"value": str(x)}

        return {
            "status": status,
            "report_id": config_id,
            "summary": summary,
            "latest": latest,
            "details": [to_dict(x) for x in report],
            "frequency": frequency.get_text(),
        }
