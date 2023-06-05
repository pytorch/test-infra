from collections import defaultdict
import json
from typing import Any, List, Dict
import requests

ENABLED_REPOS = [
    # format is (org, repo)
    ("pytorch", "pytorch"),
]

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

HEADERS = {"Authorization": f"token {os.environ.get('GITHUB_TOKEN')}"}
CREATE_ISSUE_URL = (
    f"https://api.github.com/repos/{REPO_OWNER}/{TEST_INFRA_REPO_NAME}/issues"
)
UPDATE_ISSUE_URL = (
    f"https://api.github.com/repos/{REPO_OWNER}/{TEST_INFRA_REPO_NAME}/issues/"
)

GRAPHQL_URL = "https://api.github.com/graphql"

ISSUES_WITH_LABEL_QUERY = """
query ($owner: String!, $name: String!, $labels: [String!]) {
  repository(owner: $owner, name: $name, followRenames: false) {
    issues(last: 10, labels: $labels, states: [OPEN]) {
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

def fetch_alerts(
    repo: str, branch: str, alert_repo: str, labels: List[str]
) -> List[Any]:
    try:
        variables = {"owner": REPO_OWNER, "name": alert_repo, "labels": labels}
        r = requests.post(
            GRAPHQL_URL,
            json={"query": ISSUES_WITH_LABEL_QUERY, "variables": variables},
            headers=HEADERS,
        )
        r.raise_for_status()

        data = json.loads(r.text)
        # Return only alert belonging to the target repo and branch
        return list(
            filter(
                lambda alert: f"Recurrently Failing Jobs on {repo} {branch}"
                in alert["title"],
                data["data"]["repository"]["issues"]["nodes"],
            )
        )
    except Exception as e:
        raise RuntimeError("Error fetching alerts", e)

def publish_alerts(alerts: List[Dict[str, Any]]):
    # alert_dict is indexed as: org: repo: alert_type: List of Alerts
    alert_dict =  defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: []))))
    individual_alert_dict = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: [])))))
    oncall_alert_dict = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: [])))))
    for alert in alerts:
        if (alert["organization"], alert["repo"]) not in ENABLED_REPOS:
            continue
        alert_dict[alert["organization"]][alert["repo"]][alert["AlertType"]].append(alert)
        for oncall in alert["oncalls"]:
            oncall_alert_dict[oncall][alert["organization"]][alert["repo"]][alert["AlertType"]].append(alert)
        for individual in alert["individuals"]:
            individual_alert_dict[individual][alert["organization"]][alert["repo"]][alert["AlertType"]].append(alert)
        
    

        
