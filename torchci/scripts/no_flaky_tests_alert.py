import argparse
import json
import os
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import requests
from check_alerts import (
    GRAPHQL_URL,
    PYTORCH_REPO_NAME,
    TEST_INFRA_REPO_NAME,
    REPO_OWNER,
    create_issue,
    fetch_alerts,
    headers,
)
from setuptools import distutils  # type: ignore[import]

FLAKY_TESTS_LABEL = "module: flaky-tests"
NO_FLAKY_TESTS_LABEL = "no-flaky-tests-alert"
FLAKY_TESTS_SEARCH_PERIOD_DAYS = 7
UPPER_THRESHOLD_PER_DAY = 10

NUM_ISSUES_QUERY = """
query ($query: String!) {
  search(type: ISSUE, query: $query) {
    issueCount
  }
}
"""


def num_open_issues_with_label(
    owner: str, repo: str, label: str, from_date: Optional[str] = None
) -> int:
    query = f'repo:{owner}/{repo} label:"{label}" is:issue is:open'
    if from_date:
        query += f" created:>={from_date}"
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
        f"the repository {REPO_OWNER}/{PYTORCH_REPO_NAME}.\n"
        "This can be an indication that the flaky test bot has stopped filing tests."
    )
    issue["labels"] = [NO_FLAKY_TESTS_LABEL]

    return issue


def handle_flaky_tests_alert(dry_run: bool) -> Dict:
    from_date = (
        datetime.today() - timedelta(days=FLAKY_TESTS_SEARCH_PERIOD_DAYS)
    ).strftime("%Y-%m-%d")
    num_issues_with_flaky_tests_label = num_open_issues_with_label(
        REPO_OWNER, PYTORCH_REPO_NAME, FLAKY_TESTS_LABEL, from_date
    )
    print(
        f"Num issues with `{FLAKY_TESTS_LABEL}` label: ",
        num_issues_with_flaky_tests_label,
    )
    if num_issues_with_flaky_tests_label == 0:
        return create_issue(generate_no_flaky_tests_issue(), dry_run)


def check_for_no_flaky_tests_alert(dry_run: bool):
    num_existing_alerts = num_open_issues_with_label(
        REPO_OWNER, TEST_INFRA_REPO_NAME, NO_FLAKY_TESTS_LABEL
    )
    if num_existing_alerts == 0:
        handle_flaky_tests_alert(dry_run)


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
