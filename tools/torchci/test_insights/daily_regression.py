import datetime
import json
from collections import defaultdict
from functools import lru_cache
from typing import Any
from urllib.parse import quote

from torchci.test_insights.file_report_generator import FileReportGenerator
from torchci.test_insights.weekly_notification import send_to_aws_alerting_lambda


FILE_REPORT_URL = "https://hud.pytorch.org/tests/fileReport"

CORE_TEAM_LABELS = [
    "module: unknown",
    "module: decompositions",
    "module: nn",
    "module: optimizer",
    "module: autograd",
    "module: complex",
    "module: fx",
    "module: __torch_function__",
    "oncall: fx",
]


def name_in_info_anywhere(info: dict[str, Any], name: str) -> bool:
    """Check if name appears in any of short_job_name, file, or labels in info."""
    return (
        name in info.get("short_job_name", "")
        or name in info.get("file", "")
        or any(name in label for label in info.get("labels", []))
    )


def get_name_in_info_anywhere_link(name: str) -> str:
    """Generate a link to the file report with filters for name in short_job_name, file, or labels."""
    return f"{FILE_REPORT_URL}?label={name}&job={name}&file={name}&labelRegex=true&jobRegex=true&fileRegex=true&useOrFilter=true"


CONFIG: list[dict[str, Any]] = [
    {
        "team": "pytorch-dev-infra",
        "condition": lambda _: True,
        "link": FILE_REPORT_URL,
    },
    {
        "team": "optim",
        "condition": lambda info: "module: optimizer" in info.get("labels", []),
        "link": f"{FILE_REPORT_URL}?label=module:%20optimizer",
    },
    {
        "team": "mps",
        "condition": lambda info: "mac" in info.get("short_job_name", ""),
        "link": f"{FILE_REPORT_URL}?job=mac&jobRegex=true",
    },
    {
        "team": "dynamo",
        "condition": lambda info: name_in_info_anywhere(info, "dynamo"),
        "link": get_name_in_info_anywhere_link("dynamo"),
    },
    {
        "team": "Inductor",
        "condition": lambda info: name_in_info_anywhere(info, "inductor"),
        "link": get_name_in_info_anywhere_link("inductor"),
    },
    {
        "team": "distributed",
        "condition": lambda info: name_in_info_anywhere(info, "distributed"),
        "link": get_name_in_info_anywhere_link("distributed"),
    },
    {
        "team": "core",
        "condition": lambda info: len(
            set(CORE_TEAM_LABELS).intersection(set(info.get("labels", [])))
        )
        > 0,
        "link": f"{FILE_REPORT_URL}?label={quote('|'.join(CORE_TEAM_LABELS))}&labelRegex=true",
    },
]


class RegressionNotification:
    """
    Class to handle regression notifications for test insights.
    """

    def __init__(self):
        self.file_report_generator = FileReportGenerator(dry_run=True)

    @lru_cache
    def _previous_regression_sha(self) -> str:
        text = self.file_report_generator._fetch_from_s3(
            "ossci-raw-job-status",
            "additional_info/weekly_file_report/regression_metadata.json.gz",
        )
        data = json.loads(text)
        return data

    def gen_regression_for_team(
        self,
        team: dict[str, Any],
        prev_invoking_file_info: list[dict[str, Any]],
        curr_invoking_file_info: list[dict[str, Any]],
        status_changes: list[dict[str, Any]],
    ) -> dict[str, Any]:
        relevant_status_changes = [
            change for change in status_changes if team["condition"](change)
        ]
        # Aggregate status changes
        aggregated_status_changes = defaultdict(int)
        for change in relevant_status_changes:
            aggregated_status_changes[change["status"]] += 1

        # Invoking_file_info diff
        relevant_curr_invoking_file_info = [
            info for info in curr_invoking_file_info if team["condition"](info)
        ]
        relevant_keys = set(
            (info["short_job_name"], info["file"])
            for info in relevant_curr_invoking_file_info
        )
        relevant_prev_invoking_file_info = [
            info
            for info in prev_invoking_file_info
            if (info["short_job_name"], info["file"]) in relevant_keys
        ]

        def _sum_invoking_file_info(data: list[dict[str, Any]]) -> dict[str, Any]:
            info = {
                "count": sum(item["count"] for item in data),
                "cost": sum(item["cost"] for item in data),
                "time": sum(item["time"] for item in data),
                "skipped": sum(item["skipped"] for item in data),
            }
            return info

        agg_prev_file_info = _sum_invoking_file_info(relevant_prev_invoking_file_info)
        agg_curr_file_info = _sum_invoking_file_info(relevant_curr_invoking_file_info)

        invoking_file_info_diff = {
            "count": {
                "previous": agg_prev_file_info["count"],
                "current": agg_curr_file_info["count"],
            },
            "cost": {
                "previous": agg_prev_file_info["cost"],
                "current": agg_curr_file_info["cost"],
            },
            "time": {
                "previous": agg_prev_file_info["time"],
                "current": agg_curr_file_info["time"],
            },
            "skipped": {
                "previous": agg_prev_file_info["skipped"],
                "current": agg_curr_file_info["skipped"],
            },
        }

        return {
            "status_changes": aggregated_status_changes,
            "invoking_file_info": invoking_file_info_diff,
        }

    def filter_thresholds(self, regression: dict[str, Any]) -> bool:
        def _exceeds_threshold(value: float, total: float) -> bool:
            if total == 0:
                return False
            percent_threshold = 0.1

            return (value / total) >= percent_threshold

        def _status_change_exceeds_threshold(field: str, total_field: str) -> bool:
            return _exceeds_threshold(
                regression["status_changes"].get(field, 0),
                regression["invoking_file_info"][total_field]["previous"],
            )

        def _diff_exceeds_threshold(field: str) -> bool:
            return _exceeds_threshold(
                abs(
                    regression["invoking_file_info"][field]["current"]
                    - regression["invoking_file_info"][field]["previous"]
                ),
                regression["invoking_file_info"][field]["previous"],
            )

        return (
            _status_change_exceeds_threshold("removed", "count")
            or _status_change_exceeds_threshold("added", "count")
            or _status_change_exceeds_threshold("started_skipping", "skipped")
            or _status_change_exceeds_threshold("stopped_skipping", "skipped")
            or any(
                _diff_exceeds_threshold(key)
                for key in ["cost", "count", "skipped", "time"]
            )
        )

    def format_regression_string(self, team, regression: dict[str, Any]) -> str:
        def _get_change(field: str, additional_processing) -> str:
            current = regression["invoking_file_info"][field]["current"]
            previous = regression["invoking_file_info"][field]["previous"]
            change = current - previous
            percent_change = (change / previous) * 100 if previous != 0 else 0
            percent_change = round(percent_change, 2)

            current = additional_processing(current)
            previous = additional_processing(previous)
            change = additional_processing(change)
            return f"{change} ({percent_change}%), from {previous} to {current}"

        return (
            f"Regression detected for Team:{team['team']}:\n"
            + f"Link: {team['link']}\n"
            + f"New tests: {regression['status_changes'].get('added', 0)}\n"
            + f"Removed tests: {regression['status_changes'].get('removed', 0)}\n"
            + f"Started skipping: {regression['status_changes'].get('started_skipping', 0)}\n"
            + f"Stopped skipping: {regression['status_changes'].get('stopped_skipping', 0)}\n"
            + f"Cost ($) change: {_get_change('cost', additional_processing=lambda x: round(x, 2))}\n"
            + f"Time (min) change: {_get_change('time', additional_processing=lambda x: round(x / 60, 2))}\n"
            + f"Test count change: {_get_change('count', additional_processing=lambda x: round(x, 2))}\n"
            + f"\\# skipped change: {_get_change('skipped', additional_processing=lambda x: round(x, 2))}\n"
        )

    def generate_alert_json(
        self, team: str, report_url: str, regression_str: str
    ) -> dict[str, Any]:
        title = f"Regression Detected in Test Reports for {team}"
        now = datetime.datetime.now(datetime.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.%fZ"
        )
        body = (
            f"{regression_str}\n"
            "This issue is a notification and should close immediately after creation to avoid clutter."
        )
        return {
            "schema_version": 1,
            "source": "test-infra-test-file-reports",
            "state": "FIRING",
            "title": title,
            "description": regression_str,
            "summary": regression_str,
            "priority": "P2",
            "occurred_at": now,
            "teams": [team],
            "identity": {
                "alarm_id": f"test-file-reports-daily-regression-{team}-{now}"
            },
            "links": {
                "dashboard_url": report_url,
            },
        }

    def determine_regressions(self) -> None:
        """
        Determine regressions in the test data based on the provided filter.
        Returns a list of regression entries.
        """
        previous_regression_sha = self._previous_regression_sha()
        metadata = self.file_report_generator.fetch_existing_metadata()
        curr_sha = metadata[-1]

        current_sha = curr_sha["sha"]
        if previous_regression_sha == current_sha:
            print(f"No new reports since last report: {previous_regression_sha}")
            return
        prev_sha = metadata[-2]["sha"]

        status_changes = self.file_report_generator.get_status_changes(
            sha1=prev_sha,
            sha2=current_sha,
            sha2_push_date=curr_sha["push_date"],
        )

        def _s3_to_json(bucket: str, key: str) -> Any:
            text = self.file_report_generator._fetch_from_s3(bucket, key)
            data = []
            for line in text.splitlines():
                data.append(json.loads(line))

            return data

        previous_sha_invoking_file_info = _s3_to_json(
            "ossci-raw-job-status",
            f"additional_info/weekly_file_report/data_{prev_sha}.json.gz",
        )
        current_sha_invoking_file_info = _s3_to_json(
            "ossci-raw-job-status",
            f"additional_info/weekly_file_report/data_{current_sha}.json.gz",
        )

        for team in CONFIG:
            change = self.gen_regression_for_team(
                team=team,
                prev_invoking_file_info=previous_sha_invoking_file_info,
                curr_invoking_file_info=current_sha_invoking_file_info,
                status_changes=status_changes,
            )
            if self.filter_thresholds(change):
                print(f"Regression detected for team: {team['team']}")
                print(self.format_regression_string(team, change))

                alert = self.generate_alert_json(
                    team=team["team"],
                    report_url=team["link"],
                    regression_str=self.format_regression_string(team, change),
                )
                send_to_aws_alerting_lambda(alert)
            else:
                print(f"No significant regression for team: {team['team']}")


if __name__ == "__main__":
    regression_notifier = RegressionNotification()
    regression_notifier.determine_regressions()
