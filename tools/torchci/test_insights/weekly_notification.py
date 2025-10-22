import datetime
import json
import os
import urllib.request
from typing import Any


HUD_URL_ROOT = "https://hud.pytorch.org/tests/fileReport"
CONFIG: list[dict[str, Any]] = [
    {"team": "Inductor", "link": f"{HUD_URL_ROOT}?label=module:%20inductor"},
    {
        "team": "dynamo",
        "link": f"{HUD_URL_ROOT}?file=dynamo&job=dynamo&label=dynamo&fileRegex=true&jobRegex=true&labelRegex=true&useOrFilter=true",
    },
]

TITLE = "New Test Report is Available for {team}"
REASON = (
    "A new test report has been generated for Team:{team}.  "
    "Please go to the following link to view the report: {report_url}.  "
    "This issue is a notification. Please close it after reviewing the report."
)


def generate_alert_json(
    team: str,
    report_url: str,
) -> dict[str, Any]:
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    return {
        "schema_version": 1,
        "source": "test-infra-test-file-reports",
        "state": "FIRING",
        "title": TITLE.format(team=team),
        "description": REASON.format(team=team, report_url=report_url),
        "summary": REASON.format(team=team, report_url=report_url),
        "priority": "P2",
        "occurred_at": now,
        "teams": [team],
        "identity": {"alarm_id": f"test-file-reports-weekly-notification-{team}-{now}"},
        "links": {
            "dashboard_url": report_url,
        },
    }


def send_to_aws_alerting_lambda(alert: dict[str, Any]) -> None:
    def _send(alert: dict[str, Any]) -> None:
        data = json.dumps(alert).encode()
        headers = {
            "Content-Type": "application/json",
            "x-test-reports-normalized-signature": os.environ[
                "TEST_REPORT_AWS_LAMBDA_TOKEN"
            ],
        }
        req = urllib.request.Request(
            os.environ["AWS_INFRA_ALERTS_LAMBDA_URL"],
            data=data,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req) as f:
            response = f.read()
            print(response)
            return

    _send(alert)


if __name__ == "__main__":
    for config in CONFIG:
        alert = generate_alert_json(
            team=config["team"],
            report_url=config["link"],
        )
        send_to_aws_alerting_lambda(alert)
