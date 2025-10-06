import json
import os
import urllib.request
from typing import Any


HUD_URL_ROOT = "https://hud.pytorch.org/tests/fileReport"
CONFIG: list[dict[str, Any]] = [
    {
        "team": "Inductor",
        "condition": lambda info: info["labels"].includes("module: inductor"),
        "link": f"{HUD_URL_ROOT}?label=module:%20inductor",
    }
]

TITLE = "New Test Report is Available for {module_name}"
REASON = "A new test report has been generated for Team:{team}.  Please go to the following link to view the report: {report_url}"
LABELS = ["area:alerting", "Pri:P3", "Source:custom"]


def generate_notification(
    module_name: str, team: str, report_url: str
) -> dict[str, str]:
    title = TITLE.format(module_name=module_name)
    reason = REASON.format(team=team, report_url=report_url)
    return {
        # "title": title,
        "body": reason,
        # "labels": LABELS + [f"Team:{team}"],
    }


# Using a specific issue for the time being while the alerting system is set up
# to handle custom webhooks
GITHUB_ISSUE_URL = (
    "https://api.github.com/repos/pytorch/test-infra/issues/7296/comments"
)


def create_comment(issue: dict[str, str]) -> dict[str, str]:
    # Create issue in github repo
    auth = {"Authorization": f"Bearer {os.getenv('GITHUB_TOKEN')}"}
    data = json.dumps(issue).encode()
    req = urllib.request.Request(
        GITHUB_ISSUE_URL, data=data, headers=auth, method="POST"
    )
    with urllib.request.urlopen(req) as f:
        response = f.read()
        print(f"Created issue: {response}")
    return issue


if __name__ == "__main__":
    for config in CONFIG:
        issue = generate_notification(
            module_name=config["team"], team=config["team"], report_url=config["link"]
        )

        create_comment(issue)
