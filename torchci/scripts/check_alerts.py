import json
import os
import urllib.parse
from collections import defaultdict
from curses.ascii import CAN
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from email.policy import default
from typing import Any, Dict, List, Tuple

import requests

ALL_SKIPPED_THRESHOLD = 100
SIMILARITY_THRESHOLD = 0.75
FAILURE_CHAIN_THRESHOLD = 2
HUD_API_URL = "https://hud.pytorch.org/api/hud/pytorch/pytorch/master/0"
MAX_CONCURRENT_ALERTS = 1
UPDATING_ALERT_COMMENT = "Updating alert"

PENDING = "pending"
NEUTRAL = "neutral"
SKIPPED = "skipped"
SUCCESS = "success"
FAILURE = "failure"
CANCELED = "canceled"

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

REPO_OWNER = "pytorch"
PYTORCH_REPO_NAME = "pytorch"
TEST_INFRA_REPO_NAME = "test-infra"
PYTORCH_ALERT_LABEL = "pytorch-alert"
FLAKY_TESTS_LABEL = "module: flaky-tests"
NO_FLAKY_TESTS_LABEL = "no-flaky-tests-alert"
FLAKY_TESTS_SEARCH_PERIOD_DAYS = 14
DISABLED_ALERTS = ["rerun_disabled_tests"]

headers = {"Authorization": f"token {os.environ.get('GITHUB_TOKEN')}"}
CREATE_ISSUE_URL = (
    f"https://api.github.com/repos/{REPO_OWNER}/{TEST_INFRA_REPO_NAME}/issues"
)
UPDATE_ISSUE_URL = (
    f"https://api.github.com/repos/{REPO_OWNER}/{TEST_INFRA_REPO_NAME}/issues/"
)

GRAPHQL_URL = "https://api.github.com/graphql"


class JobStatus:
    job_name: str = ""
    jobs: List[Any] = []
    current_status: Any = None
    job_statuses: List[Any] = []
    filtered_statuses: List[Any] = []
    failure_chain: List[Any] = []
    flaky_jobs: List[Any] = []

    def __init__(self, job_name: str, job_statuses: List[Any]):
        self.job_name = job_name
        self.job_statuses = job_statuses

        self.filtered_statuses = list(
            filter(is_job_not_pending_or_skipped, job_statuses)
        )
        self.current_status = self.get_current_status()
        self.failure_chain = self.get_most_recent_failure_chain()
        self.flaky_jobs = self.get_flaky_jobs()

    def get_current_status(self) -> Any:
        return self.filtered_statuses[0] if len(self.filtered_statuses) > 0 else None

    # Returns a dict of failureCaptures -> List[Jobs]
    def get_unique_failures(self) -> Dict[str, List[Any]]:
        failures = defaultdict(list)
        for job in self.filtered_statuses:
            if job["conclusion"] == "failure":
                found_similar_failure = False
                if "failureCaptures" not in job:
                    failures["unclassified"] = [job]
                    continue

                # This is now a list returned by HUD API, not a string
                failureCaptures = " ".join(job["failureCaptures"])

                for failure in failures:
                    seq = SequenceMatcher(None, failureCaptures, failure)
                    if seq.ratio() > SIMILARITY_THRESHOLD:
                        failures[failure].append(job)
                        found_similar_failure = True
                        break
                if found_similar_failure == False:
                    failures[failureCaptures] = [job]

        return failures

    # A flaky job is if it's the only job that has that failureCapture and is not the most recent job
    def get_flaky_jobs(self) -> List[Any]:
        unique_failures = self.get_unique_failures()
        flaky_jobs = []
        for failure in unique_failures:
            failure_list = unique_failures[failure]
            if (
                len(failure_list) == 1
                and failure_list[0]["sha"] != self.current_status["sha"]
            ):
                flaky_jobs.append(failure_list[0])
        return flaky_jobs

    # The most recent failure chain is an array of jobs that have the same-ish failures.
    # A success in the middle of the chain will terminate the chain.
    def get_most_recent_failure_chain(self) -> List[Any]:
        failures = []
        found_most_recent_failure = False

        for job in self.filtered_statuses:
            if job["conclusion"] != "success":
                failures.append(job)
                found_most_recent_failure = True
            if found_most_recent_failure and job["conclusion"] == "success":
                break

        return failures

    def should_alert(self) -> bool:
        return (
            self.current_status != None
            and self.current_status["conclusion"] != "success"
            and len(self.failure_chain) >= FAILURE_CHAIN_THRESHOLD
            and all(
                [
                    disabled_alert not in self.job_name
                    for disabled_alert in DISABLED_ALERTS
                ]
            )
        )

    def __repr__(self) -> str:
        return f"jobName: {self.job_name}"


def fetch_alerts(repo: str, labels: List[str]) -> List[Any]:
    try:
        variables = {"owner": REPO_OWNER, "name": repo, "labels": labels}
        r = requests.post(
            GRAPHQL_URL,
            json={"query": ISSUES_WITH_LABEL_QUERY, "variables": variables},
            headers=headers,
        )
        r.raise_for_status()
        data = json.loads(r.text)
        return data["data"]["repository"]["issues"]["nodes"]
    except Exception as e:
        raise RuntimeError("Error fetching alerts", e)


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


def generate_failed_job_issue(failed_jobs: List[JobStatus]) -> Any:
    failed_jobs.sort(key=lambda status: status.job_name)
    issue = {}
    issue[
        "title"
    ] = f"[Pytorch] There are {len(failed_jobs)} Recurrently Failing Jobs on pytorch/pytorch master"
    body = "Within the last 50 commits, there are the following failures on the master branch of pytorch: \n"
    for job in failed_jobs:
        failing_sha = job.failure_chain[-1]["sha"]
        hud_link = "https://hud.pytorch.org/minihud?name_filter=" + urllib.parse.quote(
            job.job_name
        )
        body += f"- [{job.job_name}]({hud_link}) failed consecutively starting with "
        body += f"commit [{failing_sha}](https://hud.pytorch.org/commit/{REPO_OWNER}/{REPO_OWNER}/{failing_sha})"
        body += "\n\n"

    body += "Please review the errors and revert if needed."
    issue["body"] = body
    issue["labels"] = [PYTORCH_ALERT_LABEL]

    print("Generating alerts for: ", failed_jobs)
    return issue


def generate_no_flaky_tests_issue() -> Any:
    issue = {}
    issue[
        "title"
    ] = f"[Pytorch][Warning] No flaky test issues have been detected in the past {FLAKY_TESTS_SEARCH_PERIOD_DAYS} days!"
    issue["body"] = (
        f"No issues have been filed in the past {FLAKY_TESTS_SEARCH_PERIOD_DAYS} days for the repository {REPO_OWNER}/{TEST_INFRA_REPO_NAME}. \n"
        "This can be an indication that the flaky test bot has stopped filing tests."
    )
    issue["labels"] = [NO_FLAKY_TESTS_LABEL]

    return issue


def update_issue(issue: Dict, old_issue: Any) -> Dict:
    print("Updating issue", issue)
    r = requests.patch(
        UPDATE_ISSUE_URL + str(old_issue["number"]), json=issue, headers=headers
    )
    r.raise_for_status()
    r = requests.post(
        f"https://api.github.com/repos/{REPO_OWNER}/{TEST_INFRA_REPO_NAME}/issues/{old_issue['number']}/comments",
        data=json.dumps({"body": UPDATING_ALERT_COMMENT}),
        headers=headers,
    )
    r.raise_for_status()
    return issue


def create_issue(issue: Dict) -> Dict:
    print("Creating issue", issue)
    r = requests.post(CREATE_ISSUE_URL, json=issue, headers=headers)
    r.raise_for_status()
    return issue


def fetch_hud_data() -> Any:
    response = requests.get(HUD_API_URL)
    response.raise_for_status()
    hud_data = json.loads(response.text)
    return (hud_data["jobNames"], hud_data["shaGrid"])


# TODO: Do something about these flaky jobs, save them in rockset or something
def record_flaky_jobs(flaky_jobs: List[Any]) -> None:
    return


# Creates a Dict of Job Name -> [JobData]. Essentially a Column in HUD
def map_job_data(jobNames: Any, shaGrid: Any) -> Dict[str, Any]:
    jobData = defaultdict(list)
    for sha in shaGrid:
        for ind, job in enumerate(sha["jobs"]):
            jobData[jobNames[ind]].append(job)
    return jobData


def is_job_not_pending_or_skipped(job: Any) -> bool:
    conclusion = job["conclusion"] if "conclusion" in job else None
    return not (
        conclusion is None
        or conclusion == PENDING
        or conclusion == NEUTRAL
        or conclusion == SKIPPED
    )


def get_failed_jobs(job_data: List[Any]) -> List[Any]:
    return [job for job in job_data if job["conclusion"] == "failure"]


def categorize_shas(sha_grid: Any) -> List[Tuple[Any, str]]:
    categorized_shas = []
    for sha in sha_grid:
        conclusions = defaultdict(lambda: 0)
        for job in sha["jobs"]:
            if "conclusion" in job:
                conclusions[job["conclusion"]] += 1
            else:
                conclusions[SKIPPED] += 1
        if conclusions[FAILURE] > 0 or conclusions[CANCELED]:
            categorized_shas.append((sha, FAILURE))
        elif conclusions[PENDING] > 0:
            categorized_shas.append((sha, PENDING))
        # If the SHA has 100+ skipped jobs, then that means this SHA is part of a stack and
        # everything in this commit is skipped
        elif conclusions[SKIPPED] > ALL_SKIPPED_THRESHOLD:
            categorized_shas.append((sha, SKIPPED))
        else:
            categorized_shas.append((sha, SUCCESS))
    return categorized_shas


def find_first_sha(categorized_sha: List[Tuple[str, str]], status: str):
    for ind, sha in enumerate(categorized_sha):
        if sha[1] == status:
            return ind
    return -1


def clear_alerts(alerts: List[Any]) -> bool:
    cleared_alerts = 0
    for alert in alerts:
        r = requests.patch(
            UPDATE_ISSUE_URL + str(alert["number"]),
            json={"state": "closed"},
            headers=headers,
        )
        r.raise_for_status()
        cleared_alerts += 1
    print(f"Clearing {cleared_alerts} alerts.")
    return cleared_alerts > 0


# We need to clear alerts if there is a commit that's all green is before a commit that has a red
# If there's pending things after the all green commit, that's fine, as long as it's all green/pending
def trunk_is_green(sha_grid: Any):
    categorized_shas = categorize_shas(sha_grid)
    first_green_sha_ind = find_first_sha(categorized_shas, SUCCESS)
    first_red_sha_ind = find_first_sha(categorized_shas, FAILURE)
    first_green = categorized_shas[first_green_sha_ind][0]
    first_red = categorized_shas[first_red_sha_ind][0]

    print(
        f"The first green SHA was at index {first_green_sha_ind} at {first_green['sha']}"
        + f"and the first red SHA was at index {first_red_sha_ind} at {first_red['sha']}"
    )
    if first_green_sha_ind < 0:
        return False
    return first_green_sha_ind < first_red_sha_ind


# Creates Job Statuses which has the logic for if need to alert or if there's flaky jobs
def classify_jobs(job_names: List[str], sha_grid: Any) -> Tuple[List[Any], List[Any]]:
    job_data = map_job_data(job_names, sha_grid)
    job_statuses: list[JobStatus] = []
    for job in job_data:
        job_statuses.append(JobStatus(job, job_data[job]))

    jobs_to_alert_on = []
    flaky_jobs = []

    for job_status in job_statuses:
        if job_status.should_alert():
            jobs_to_alert_on.append(job_status)
        flaky_jobs.extend(job_status.flaky_jobs)
    return (jobs_to_alert_on, flaky_jobs)


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
            return create_issue(generate_no_flaky_tests_issue())

    print("No new alert for flaky tests bots.")
    return None


def check_for_recurrently_failing_jobs_alert():
    job_names, sha_grid = fetch_hud_data()
    (jobs_to_alert_on, flaky_jobs) = classify_jobs(job_names, sha_grid)

    # Fetch alerts
    existing_alerts = fetch_alerts(TEST_INFRA_REPO_NAME, PYTORCH_ALERT_LABEL)

    # Auto-clear any existing alerts if the current status is green
    if len(jobs_to_alert_on) == 0 or trunk_is_green(sha_grid):
        print("Didn't find anything to alert on.")
        clear_alerts(existing_alerts)
        return

    # Find the existing alert for recurrently failing jobs (if any).
    # We're going to update the existing alert if possible instead of filing a new one.
    existing_recurrent_job_failure_alert = None
    for alert in existing_alerts:
        if "Recurrently Failing Jobs on pytorch/pytorch master" in alert["title"]:
            existing_recurrent_job_failure_alert = alert
            break

    # Create a new alert if no alerts are active or edit the original one if there's a new update
    if existing_recurrent_job_failure_alert:
        new_issue = generate_failed_job_issue(jobs_to_alert_on)
        if existing_recurrent_job_failure_alert["body"] != new_issue["body"]:
            update_issue(new_issue, existing_recurrent_job_failure_alert)
        else:
            print("No new updates. Not updating any alerts.")
    else:
        create_issue(generate_failed_job_issue(jobs_to_alert_on))


def check_for_no_flaky_tests_alert():
    existing_no_flaky_tests_alerts = fetch_alerts(
        TEST_INFRA_REPO_NAME, NO_FLAKY_TESTS_LABEL
    )
    handle_flaky_tests_alert(existing_no_flaky_tests_alerts)


def main():
    check_for_recurrently_failing_jobs_alert()
    check_for_no_flaky_tests_alert()


if __name__ == "__main__":
    main()
