import datetime
from typing import Any
from urllib.parse import quote

import requests
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

    previous_regression_sha_key = (
        "additional_info/weekly_file_report/regression_metadata.json.gz"
    )
    keys = [
        "cost",
        "time",
        "skipped",
        "success",
        "failure",
        "flaky",
    ]

    def __init__(self):
        self.file_report_generator = FileReportGenerator(dry_run=True)

    def gen_regression_for_team(
        self,
        team: dict[str, Any],
        prev_invoking_file_info: list[dict[str, Any]],
        curr_invoking_file_info: list[dict[str, Any]],
    ) -> dict[str, Any]:
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
            info = {}
            for key in self.keys:
                info[key] = sum(item[key] for item in data)
            return info

        agg_prev_file_info = _sum_invoking_file_info(relevant_prev_invoking_file_info)
        agg_curr_file_info = _sum_invoking_file_info(relevant_curr_invoking_file_info)

        invoking_file_info_diff = {}
        for key in self.keys:
            invoking_file_info_diff[key] = {
                "previous": agg_prev_file_info[key],
                "current": agg_curr_file_info[key],
            }

        return invoking_file_info_diff

    def filter_thresholds(self, regression: dict[str, Any]) -> bool:
        def _exceeds_threshold(value: float, total: float) -> bool:
            if total == 0:
                return False
            percent_threshold = 0.1

            return (value / total) >= percent_threshold

        def _diff_exceeds_threshold(field: str) -> bool:
            return _exceeds_threshold(
                abs(regression[field]["current"] - regression[field]["previous"]),
                regression[field]["previous"],
            )

        keys = self.keys.copy()
        keys.remove("flaky")
        return any(_diff_exceeds_threshold(key) for key in keys)

    def format_regression_string(self, team, regression: dict[str, Any]) -> str:
        def _get_change(field: str, additional_processing) -> str:
            current = regression[field]["current"]
            previous = regression[field]["previous"]
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
            + f"Cost ($) change: {_get_change('cost', additional_processing=lambda x: round(x, 2))}\n"
            + f"Time (min) change: {_get_change('time', additional_processing=lambda x: round(x / 60, 2))}\n"
            + f"\\# skipped change: {_get_change('skipped', additional_processing=lambda x: round(x, 2))}\n"
            + f"\\# success change: {_get_change('success', additional_processing=lambda x: round(x, 2))}\n"
            + f"\\# failure change: {_get_change('failure', additional_processing=lambda x: round(x, 2))}\n"
            # + f"\\# flaky change: {_get_change('flaky', additional_processing=lambda x: round(x, 2))}\n"
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

    def get_representative_data_for_time(
        self, start_date, stop_date
    ) -> list[dict[str, Any]]:
        response = requests.get(
            f"https://hud.pytorch.org/api/flaky-tests/fileReport?startDate={start_date}&endDate={stop_date}"
        )

        if response.status_code != 200:
            raise RuntimeError(
                f"Failed to fetch file report data: {response.status_code} {response.text}"
            )
        data = response.json()
        results = data["results"]
        costInfo = data["costInfo"]
        shas = data["shas"]
        testOwnerLabels = data["testOwnerLabels"]

        for row in results:
            costMatch = next((r for r in costInfo if r["label"] == row["label"]), None)
            ownerLabels = next(
                (r for r in testOwnerLabels if r["file"] == f"{row['file']}.py"), None
            )
            commit = next((s for s in shas if s["sha"] == row["sha"]), None)
            row["cost"] = (
                row["time"] * (costMatch["price_per_hour"] if costMatch else 0)
            ) / 3600
            row["short_job_name"] = f"{row['workflow_name']} / {row['job_name']}"
            row["labels"] = ownerLabels["owner_labels"] if ownerLabels else ["unknown"]
            row["push_date"] = commit["push_date"] if commit else 0
            row["sha"] = commit["sha"] if commit else "unknown"

        # choose a commit with the median number of rows
        if not results:
            raise RuntimeError("No data found for the given time range.")

        # group by job name, file
        grouped_data: dict[str, list[dict[str, Any]]] = {}
        for row in results:
            key = f"{row['short_job_name']}|{row['file']}"
            if key not in grouped_data:
                grouped_data[key] = []
            grouped_data[key].append(row)

        # get median for each job name, file
        representative_data: list[dict[str, Any]] = []
        for key, rows in grouped_data.items():
            median_row = sorted(
                rows,
                key=lambda x: (x["failure"], x["flaky"], x["skipped"], x["success"]),
            )[len(rows) // 2]
            representative_data.append(median_row)
        return representative_data

    def determine_regressions(self) -> None:
        """
        Determine regressions in the test data based on the provided filter.
        Returns a list of regression entries.
        """
        # Choose 5 commits between 5 hours ago and 1d5h ago
        current_sha = self.get_representative_data_for_time(
            datetime.datetime.now(datetime.timezone.utc).timestamp() - 3600 * 29,
            datetime.datetime.now(datetime.timezone.utc).timestamp() - 3600 * 5,
        )

        yesterday_sha = self.get_representative_data_for_time(
            datetime.datetime.now(datetime.timezone.utc).timestamp() - 3600 * 53,
            datetime.datetime.now(datetime.timezone.utc).timestamp() - 3600 * 29,
        )

        for team in CONFIG:
            change = self.gen_regression_for_team(
                team=team,
                prev_invoking_file_info=yesterday_sha,
                curr_invoking_file_info=current_sha,
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
