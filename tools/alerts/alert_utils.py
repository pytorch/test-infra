import re
from typing import Dict, Any, List, Union

import urllib
import os
import requests
import json

ALL_SKIPPED_THRESHOLD = 100
SIMILARITY_THRESHOLD = 0.75
FAILURE_CHAIN_THRESHOLD = 2
MAX_CONCURRENT_ALERTS = 1
FAILED_JOB_PATTERN = (
    r"^- \[(.*)\]\(.*\) failed consecutively starting with commit \[.*\]\(.*\)$"
)

PENDING = "pending"
NEUTRAL = "neutral"
SKIPPED = "skipped"
SUCCESS = "success"
FAILURE = "failure"
CANCELED = "canceled"

ISSUES_WITH_LABEL_QUERY = """
query ($owner: String!, $name: String!, $labels: [String!]) {
  repository(owner: $owner, name: $name, followRenames: false) {
    issues(last: 20, labels: $labels, orderBy: {field: UPDATED_AT, direction: ASC} ) {
      nodes {
        id
        title
        closed
        number
        body
        createdAt
        comments(first: 100) {
          nodes {
            bodyText
            databaseId
          }
        }
      }
    }
  }
}
"""

NUM_ISSUES_QUERY = """
query ($query: String!) {
  search(type: ISSUE, query: $query) {
    issueCount
  }
}
"""

REPO_OWNER = "pytorch"
PYTORCH_REPO_NAME = "pytorch"
TEST_INFRA_REPO_NAME = "test-infra"
PYTORCH_ALERT_LABEL = "pytorch-alert"
FLAKY_TESTS_LABEL = "module: flaky-tests"
NO_FLAKY_TESTS_LABEL = "no-flaky-tests-alert"
FLAKY_TESTS_SEARCH_PERIOD_DAYS = 14
DISABLED_ALERTS = [
    "rerun_disabled_tests",
    "unstable",
]

headers = {"Authorization": f"token {os.environ.get('GITHUB_TOKEN')}"}
CREATE_ISSUE_URL = (
    f"https://api.github.com/repos/{REPO_OWNER}/{TEST_INFRA_REPO_NAME}/issues"
)
UPDATE_ISSUE_URL = (
    f"https://api.github.com/repos/{REPO_OWNER}/{TEST_INFRA_REPO_NAME}/issues/"
)

GRAPHQL_URL = "https://api.github.com/graphql"

# rename this when these are ready
# PYTORCH_ALERT_LABEL = "pytorch-alert"
PYTORCH_ALERT_LABEL = "pytorch-alert-test"

headers = {"Authorization": f"token {os.environ.get('GITHUB_TOKEN')}"}

def fetch_alerts(
    labels: List[str],
    alert_repo_owner: str = REPO_OWNER,
    alert_repo_name: str = TEST_INFRA_REPO_NAME,
) -> List[Any]:
    try:
        variables = {
            "owner": alert_repo_owner,
            "name": alert_repo_name,
            "labels": labels,
        }
        r = requests.post(
            GRAPHQL_URL,
            json={"query": ISSUES_WITH_LABEL_QUERY, "variables": variables},
            headers=headers,
        )
        r.raise_for_status()
        return json.loads(r.text)["data"]["repository"]["issues"]["nodes"]
    except Exception as e:
        raise RuntimeError("Error fetching alerts", e)

 

def fetch_alerts_filter(repo: str, labels: List[str], alertType: str) -> List[Any]:
    alerts = fetch_alerts(labels)
    return [
        alert
        for alert in alerts
        if f"{repo}" in alert["title"] and alertType in alert["title"]
    ]

def _assert_same_repo_and_type(alerts: List[Dict[str, Any]]) -> None:
    repo = alerts[0]["repo"]
    alert_type = alerts[0]["AlertType"]
    alert_org = alerts[0]["org"]
    for alert in alerts:
        if alert["repo"] != repo:
            raise ValueError(
                f"Alerts must be from the same repository, got {repo} and {alert['repo']}"
            )
        if alert["AlertType"] != alert_type:
            raise ValueError(
                f"Alerts must be of the same type, got {alert_type} and {alert['AlertType']}"
            )
        if alert["org"] != alert_org:
            raise ValueError(
                f"Alerts must be of the same org, got {alert_org} and {alert['org']}"
            )

def update_issue(
    issue: Dict, old_issue: Any, dry_run: bool = False
) -> None:
    # print(f"Updating issue {issue} with content:{os.linesep}{issue}")
    issue["state"] = "open"
    if dry_run:
        print("NOTE: Dry run, not doing any real work")
        return
    r = requests.patch(
        UPDATE_ISSUE_URL + str(old_issue["number"]), json=issue, headers=headers
    )
    r.raise_for_status()

def clear_alerts(alerts: List[Any], dry_run: bool = False) -> bool:
    if dry_run:
        print("NOTE: Dry run, not doing any real work")
        return
    cleared_alerts = 0
    for alert in alerts:
        if not alert["closed"]:
            r = requests.patch(
                UPDATE_ISSUE_URL + str(alert["number"]),
                json={"state": "closed"},
                headers=headers,
            )
            r.raise_for_status()
            cleared_alerts += 1
    print(f"Clearing {cleared_alerts} previously open alerts.")
    return cleared_alerts > 0

def create_issue(issue: Dict, dry_run: bool = False) -> Dict:
    print(f"Creating issue with content:{os.linesep}{issue}")
    if dry_run:
        print("NOTE: Dry run activated, not doing any real work")
        return
    r = requests.post(CREATE_ISSUE_URL, json=issue, headers=headers)
    r.raise_for_status()
    return {"number": r.json()["number"], "closed": False}