from collections import defaultdict
import json
import pprint
from typing import Any, List, Dict
import requests
import rockset
import os

from alert_registry import ALERT_REGISTRY

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

RELEVANT_QUERIES_VERSION = "5a66b6108b2ac5b1"
def get_recent_alerts(orgname, reponame):
    rockset_api_key = os.environ["ROCKSET_API_KEY"]
    rockset_api_server = "api.rs2.usw2.rockset.com"
    rs = rockset.RocksetClient(
        host="api.usw2a1.rockset.com", api_key=rockset_api_key
    )

    # Define the name of the Rockset collection and lambda function
    collection_name = "commons"
    lambda_function_name = "get_relevant_alerts"
    query_parameters = [
        rockset.models.QueryParameter(name="repo", type="string", value=reponame),
        rockset.models.QueryParameter(name="organization", type="string", value=orgname),
    ]
    api_response = rs.QueryLambdas.execute_query_lambda(query_lambda=lambda_function_name, 
                                                        workspace=collection_name,
                                                        version=RELEVANT_QUERIES_VERSION, 
                                                        parameters=query_parameters)
    return api_response["results"]

def publish_alerts(alerts: List[Dict[str, Any]]):
    # alert_dict is indexed as: org: repo: alert_type: List of Alerts
    alert_dict =  defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: [])))
    for alert in alerts:
        if (alert["organization"], alert["repo"]) not in ENABLED_REPOS:
            continue
        alert_dict[alert["organization"]][alert["repo"]][alert["AlertType"]].append(alert)
    
    for org, repo_dict in alert_dict.items():
        for repo, alert_type_dict in repo_dict.items():
            for alert_type, alerts in alert_type_dict.items():
                if alert_type in DISABLED_ALERTS:
                    continue
                ALERT_REGISTRY[alert_type](alerts)
    

if __name__ == "__main__":
    alerts = get_recent_alerts("pytorch", "pytorch")
    pprint.pprint(alerts) 
    published_alerts = publish_alerts(alerts)
    # pprint.pprint(published_alerts)