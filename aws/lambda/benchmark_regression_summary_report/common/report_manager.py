import datetime as dt
import json
import logging
import uuid
from typing import Any, Dict

import clickhouse_connect
from common.config_model import BenchmarkConfig, ReportConfig, to_dict
from common.regression_utils import BenchmarkRegressionReport, get_regression_status
from jinja2 import Template


logger = logging.getLogger()
REPORT_MD_TEMPLATE = """# Benchmark Report {{ id }}
config_id: `{{ report_id }}`

See Page https://hud.pytorch.org/benchmark/regression/report/{{ id }} for more details.

Report Status: **{{ status }}**

- Total: {{ summary.total_count | default(0) }}
- Regressions: {{ summary.regression_count | default(0) }}
- Suspicious: {{ summary.suspicious_count | default(0) }}
- No Regression: {{ summary.no_regression_count | default(0) }}
- Insufficient Data: {{ summary.insufficient_data_count | default(0) }}
"""


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

        self.raw_report = regression_report

        self.config_id = config.id
        self.config = config
        self.type = type
        self.repo = repo
        self.db_table_name = db_table_name

        self.id = str(uuid.uuid4())

        # extract latest meta data from report
        self.baseline = self.raw_report["baseline_meta_data"]
        self.target = self.raw_report["new_meta_data"]
        self.target_latest_commit = self.target["end"]["commit"]
        self.target_latest_ts_str = self.target["end"]["timestamp"]
        self.status = get_regression_status(self.raw_report["summary"])

        self.report_data = self._to_report_data(
            config_id=config.id,
            regression_report=self.raw_report,
            config=self.config,
            status=self.status,
        )

    def run(
        self, cc: clickhouse_connect.driver.client.Client, github_token: str
    ) -> None:
        """
        main method used to insert the report to db and create github comment in targeted issue
        """
        try:
            applied_insertion = self.insert_to_db(cc)
        except Exception as e:
            logger.error(f"failed to insert report to db, error: {e}")
            raise
        if not applied_insertion:
            logger.info("[%s] skip notification,  already exists in db", self.config_id)
            return
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
        logger.info("[%s] prepareing gitub comment content", self.config_id)
        content = self._to_markdown()
        if self.is_dry_run:
            logger.info(
                "[%s]dry run, skip sending comment to github, report(%s)",
                self.config_id,
                self.id,
            )
            logger.info("[dry run] printing comment content")
            print(json.dumps(content, indent=2, default=str))
            logger.info("[dry run] Done! Finish printing comment content")
            return
        logger.info("[%s] create comment to github issue", self.config_id)
        github_notification.create_github_comment(content, github_token)
        logger.info("[%s] done. comment is sent to github", self.config_id)

    def _to_markdown(self) -> str:
        regression_items = [
            r for r in self.raw_report["results"] if r.get("label") == "regression"
        ]
        url = (self.config.hud_info or {}).get("url", "")
        return Template(
            REPORT_MD_TEMPLATE, trim_blocks=True, lstrip_blocks=True
        ).render(
            id=self.id,
            url=url,
            status=self.status,
            report_id=self.config_id,
            summary=self.raw_report["summary"],
            baseline=self.baseline,
            target=self.target,
            frequency=self.config.policy.frequency.get_text(),
            regression_items=regression_items,
        )

    def insert_to_db(
        self,
        cc: clickhouse_connect.driver.client.Client,
    ) -> bool:
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
                self.report_data, ensure_ascii=False, separators=(",", ":"), default=str
            )
        except Exception:
            logger.exception(
                "[%s] failed to serialize report data to json",
                self.config_id,
            )
            raise

        regression_summary = self.raw_report["summary"]
        params = {
            "id": str(self.id),
            "report_id": self.config_id,
            "type": self.type,
            "status": get_regression_status(self.raw_report["summary"]),
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

        if self.is_dry_run:
            logger.info(
                "[%s]dry run, skip inserting report to db, report(%s)",
                self.config_id,
                self.id,
            )
            if self.is_dry_run:
                logger.info("[dry run] printing db params data")
                print({k: v for k, v in params.items() if k != "report_json"})
                print(json.dumps(self.report_data, indent=2, default=str))
            logger.info("[dry run] Done! Finish printing db params data")
            return False
        logger.info(
            "[%s]inserting benchmark regression report(%s)", self.config_id, self.id
        )
        try:
            if self._row_exists(
                cc,
                self.db_table_name,
                params["report_id"],
                params["type"],
                params["repo"],
                params["last_record_ts"],
            ):
                logger.info(
                    "[%s] report already exists, skip inserting report to db, report(%s)",
                    self.config_id,
                    self.id,
                )
                return False
            self._db_insert(cc, self.db_table_name, params)
            logger.info(
                "[%s] Done. inserted benchmark regression report(%s)",
                self.config_id,
                self.id,
            )
            return True
        except Exception:
            logger.exception(
                "[%s] failed to insert report to target table %s",
                self.config_id,
                self.db_table_name,
            )
            raise

    def _db_insert(
        self,
        cc: clickhouse_connect.driver.Client,
        table: str,
        params: dict,
    ):
        """
        Insert one row into ClickHouse using cc.insert().
        Returns (inserted, written_rows).
        """
        if self._row_exists(
            cc,
            table,
            params["report_id"],
            params["type"],
            params["repo"],
            params["last_record_ts"],
        ):
            return False, 0

        sql = f"""
            INSERT INTO {table} (
                id,
                report_id,
                last_record_ts,
                last_record_commit,
                type,
                status,
                regression_count,
                insufficient_data_count,
                suspected_regression_count,
                total_count,
                repo,
                report
            )
            VALUES
            (
                %(id)s,
                %(report_id)s,
                %(last_record_ts)s,
                %(last_record_commit)s,
                %(type)s,
                %(status)s,
                %(regression_count)s,
                %(insufficient_data_count)s,
                %(suspected_regression_count)s,
                %(total_count)s,
                %(repo)s,
                %(report_json)s
            )
            """
        cc.command(sql, parameters=params)

    def _row_exists(
        self,
        cc: clickhouse_connect.driver.Client,
        table: str,
        report_id: str,
        type_str: str,
        repo: str,
        last_record_ts,
    ) -> bool:
        """
        Check if a row already exists with the same (report_id, type, repo, stamp).
        Returns True if found, False otherwise.
        Stamp is the datetime of the last record ts, this makes sure we only insert one
        report for a (config,type) per day.
        """
        sql = f"""
            SELECT 1
            FROM {table}
            WHERE report_id = %(report_id)s
            AND type = %(type)s
            AND repo = %(repo)s
            AND stamp = toDate(%(last_record_ts)s)
            LIMIT 1
        """
        res = cc.query(
            sql,
            parameters={
                "report_id": report_id,
                "type": type_str,
                "repo": repo,
                "last_record_ts": last_record_ts,
            },
        )
        return bool(res.result_rows)

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
        config: BenchmarkConfig,
        regression_report: BenchmarkRegressionReport,
        status: str,
    ) -> dict[str, Any]:
        if not self.target_latest_commit:
            raise ValueError(
                f"missing commit from new is required, latest is {self.target}"
            )

        filtered = self._filter_report(regression_report, config.report_config)
        logger.info("policy: %s", to_dict(self.config.policy))
        return {
            "status": status,
            "report_id": config_id,
            "policy": to_dict(config.policy),
            "report": to_dict(filtered),
        }

    def _filter_report(
        self, report: BenchmarkRegressionReport, report_config: ReportConfig
    ) -> dict[str, Any]:
        new_report = {k: v for k, v in report.items() if k != "results"}
        level_order = report_config.get_severity_map()
        threshold = report_config.get_order()

        new_report["results"] = [
            r for r in report["results"] if level_order[r["label"]] >= threshold
        ]
        return new_report
