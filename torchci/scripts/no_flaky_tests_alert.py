import argparse
import json
import os
from datetime import datetime, timedelta
from typing import Any, Dict, List

import requests
from check_alerts import (
    GRAPHQL_URL,
    PYTORCH_REPO_NAME,
    REPO_OWNER,
    TEST_INFRA_REPO_NAME,
    create_issue,
    fetch_alerts,
    headers,
)
from setuptools import distutils  # type: ignore[import]

FLAKY_TESTS_LABEL = "module: flaky-tests"
NO_FLAKY_TESTS_LABEL = "no-flaky-tests-alert"
FLAKY_TESTS_SEARCH_PERIOD_DAYS = 14

NUM_ISSUES_QUERY = """
query ($query: String!) {
  search(type: ISSUE, query: $query) {
    issueCount
  }
}
"""


def get_num_issues_with_label(owner: str, repo: str, label: str, from_date: str) -> int:
    query = f'repo:{owner}/{repo} label:"{label}" created:>={from_date} is:issue'
    try:
        r = requests.post(
            GRAPHQL_URL,
            json={"query": NUM_ISSUES_QUERY, "variables": {"query": query}},
            headers=headers,
        )
        r.raise_for_status()
        data = json.loads(r.text)
        return data["data"]["search"]["issueCount"]
    except Exception as e:
        raise RuntimeError("Error fetching issues count", e)


def generate_no_flaky_tests_issue() -> Any:
    issue = {}
    issue[
        "title"
    ] = f"[Pytorch][Warning] No flaky test issues have been detected in the past {FLAKY_TESTS_SEARCH_PERIOD_DAYS} days!"
    issue["body"] = (
        f"No issues have been filed in the past {FLAKY_TESTS_SEARCH_PERIOD_DAYS} days for "
        f"the repository {REPO_OWNER}/{TEST_INFRA_REPO_NAME}.\n"
        "This can be an indication that the flaky test bot has stopped filing tests."
    )
    issue["labels"] = [NO_FLAKY_TESTS_LABEL]

    return issue


def handle_flaky_tests_alert(existing_alerts: List[Dict]) -> Dict:
    if (
        not existing_alerts
        or datetime.fromisoformat(
            existing_alerts[0]["createdAt"].replace("Z", "+00:00")
        ).date()
        != datetime.today().date()
    ):
        from_date = (
            datetime.today() - timedelta(days=FLAKY_TESTS_SEARCH_PERIOD_DAYS)
        ).strftime("%Y-%m-%d")
        num_issues_with_flaky_tests_lables = get_num_issues_with_label(
            REPO_OWNER, PYTORCH_REPO_NAME, FLAKY_TESTS_LABEL, from_date
        )
        print(
            f"Num issues with `{FLAKY_TESTS_LABEL}` label: ",
            num_issues_with_flaky_tests_lables,
        )
        if num_issues_with_flaky_tests_lables == 0:
            return create_issue(generate_no_flaky_tests_issue(), False)

    print("No new alert for flaky tests bots.")
    return None


def check_for_no_flaky_tests_alert(dry_run: bool):
    existing_no_flaky_tests_alerts = fetch_alerts(
        labels=[NO_FLAKY_TESTS_LABEL],
    )
    handle_flaky_tests_alert(existing_no_flaky_tests_alerts)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dry-run",
        type=distutils.util.strtobool,
        default=os.getenv("DRY_RUN", "YES"),
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    check_for_no_flaky_tests_alert(args.dry_run)
