import json
import os
import urllib.parse
from collections import defaultdict
from curses.ascii import CAN
from difflib import SequenceMatcher
from email.policy import default
from typing import Any, List, Tuple, Dict

import requests

os.environ["GITHUB_TOKEN"] = "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"
HUD_API_URL = "https://hud.pytorch.org/api/hud/pytorch/pytorch/master/0"
MAX_CONCURRENT_ALERTS = 1

PENDING = "pending"
NEUTRAL = "neutral"
SKIPPED = "skipped"
SUCCESS = "success"
FAILURE = "failure"
CANCELED = "canceled"

ISSUES_WITH_LABEL_QUERY = """
query ($owner: String!, $name: String!, $labels: [String!]) {
  repository(owner: $owner, name: $name, followRenames: false) {
    issues(first: 10, labels: $labels, states: [OPEN]) {
      nodes {
        id
        title
        closed
        number
      }
    }
  }
}
"""
REPO_OWNER = "pytorch"
REPO_NAME = "test-infra"
failure_label = "pytorch-alert"
labels = [failure_label]
headers = {"Authorization": f"token {os.environ.get('GITHUB_TOKEN')}"}


CREATE_ISSUE_URL = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/issues"
UPDATE_ISSUE_URL = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/issues/"

GRAPHQL_URL = "https://api.github.com/graphql"


class JobStatus:
    job_name: str = ""
    jobs: List[Any] = []
    current_status: str = None
    job_statuses: List[Any] = []
    failure_chain: List[Any] = []
    flaky_jobs: List[Any] = []

    def __init__(self, job_name: str, job_statuses: List[Any]):
        self.job_name = job_name
        self.job_statuses = job_statuses

        filtered_statuses = list(filter(is_job_not_pending_or_skipped, job_statuses))
        self.current_status = self.get_current_status(filtered_statuses)
        self.failure_chain = self.get_most_recent_failure_chain(filtered_statuses)
        self.flaky_jobs = self.get_flaky_jobs(filtered_statuses)

    def get_current_status(self, job_statuses: List[Any]) -> str:
        return job_statuses[0] if len(job_statuses) > 0 else None

    # Returns a dict of failureCaptures -> List[Jobs]
    def get_unique_failures(self, job_statuses: List[Any]) -> Dict[str, List[Any]]:
        failures = {}
        for job in job_statuses:
            if job["conclusion"] == "failure":
                found_similar_failure = False
                if "failureCaptures" not in job:
                    if "unclassified" not in failures:
                        failures["unclassified"] = []
                    failures["unclassified"].append(job)
                    continue

                for failure in failures:
                    seq = SequenceMatcher(None, job["failureCaptures"], failure)
                    if seq.ratio() > 0.75:
                        failures[failure].append(job)
                        found_similar_failure = True
                        break
                if found_similar_failure == False:
                    failures[job["failureCaptures"]] = [job]

        return failures

    # A flaky job is if it's the only job that has that failureCapture and is not the most recent job
    def get_flaky_jobs(self, job_statuses: List[Any]) -> List[Any]:
        unique_failures = self.get_unique_failures(job_statuses)
        flaky_jobs = []
        for failure in unique_failures:
            if len(failure) == 1 and failure["sha"] != self.current_status["sha"]:
                flaky_jobs.append(failure)
        return flaky_jobs

    # The most recent failure chain is an array of jobs that have the same-ish failures.
    # A success in the middle of the chain will terminate the chain.
    def get_most_recent_failure_chain(self, job_statuses: List[Any]) -> List[Any]:
        failures = []
        found_most_recent_failure = False

        for job in job_statuses:
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
            and len(self.failure_chain) >= 2
        )

    def __repr__(self) -> str:
        return f"jobName: {self.job_name}"


def fetch_alerts() -> Any:
    variables = {"owner": REPO_OWNER, "name": REPO_NAME, "labels": labels}
    r = requests.post(
        GRAPHQL_URL,
        json={"query": ISSUES_WITH_LABEL_QUERY, "variables": variables},
        headers=headers,
    )
    data = json.loads(r.text)
    return data["data"]["repository"]["issues"]["nodes"]


def generate_failed_job_issue(failed_jobs: List[JobStatus]) -> Any:
    issue = {}
    issue[
        "title"
    ] = f"[Pytorch] There are {len(failed_jobs)} Recurrently Failing Jobs on pytorch/pytorch master"
    body = "Within the last 50 commits, there are the following failures on the master branch of pytorch: "
    for job in failed_jobs:
        failing_sha = job.failure_chain[-1]["sha"]
        hud_link = "https://hud.pytorch.org/minihud?name_filter=" + urllib.parse.quote(
            job.job_name
        )
        body += f"[{job.job_name}]({hud_link}) failed {len(job.failure_chain)} times consecutively starting with "
        body += f"commit [{failing_sha}](https://hud.pytorch.org/commit/{REPO_OWNER}/{REPO_OWNER}/{failing_sha})"
        body + "\n"

    body += "Please review the errors and revert if needed."
    issue["labels"] = labels
    issue["assignees"] = ["zengk95"]

    print("Creating alerts for: ", failed_jobs)
    return issue


def create_issue(issue: Any) -> None:
    requests.post(CREATE_ISSUE_URL, json=issue, headers=headers)


def fetch_hud_data() -> Any:
    response = requests.get(HUD_API_URL)
    hud_data = json.loads(response.text)
    return (hud_data["jobNames"], hud_data["shaGrid"])


# TODO: Do something about these flaky jobs, save them in rockset or something
def record_flaky_jobs(flaky_jobs: List[Any]) -> None:
    return


# Creates a Dict of Job Name -> [JobData]. Essentially a Column in HUD
def map_job_data(jobNames: Any, shaGrid: Any) -> Dict[str, Any]:
    jobData = {}
    for sha in shaGrid:
        for ind, job in enumerate(sha["jobs"]):
            if jobNames[ind] not in jobData:
                jobData[jobNames[ind]] = []
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
        elif conclusions[SKIPPED] > 100:
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
        requests.patch(
            UPDATE_ISSUE_URL + str(alert["number"]),
            json={"state": "closed"},
            headers=headers,
        )
        cleared_alerts += 1
    print(f"Clearing {cleared_alerts} alerts.")
    return cleared_alerts > 0


# We need to clear alerts is there is a commit that's all green is before a commit that has a red
# If there's pending things after the all green commit, that's fine, as long as it's all green/pending
def should_clear_alerts(sha_grid: Any):
    categorized_shas = categorize_shas(sha_grid)
    first_green_sha_ind = find_first_sha(categorized_shas, SUCCESS)
    first_red_sha_ind = find_first_sha(categorized_shas, FAILURE)
    first_green = categorized_shas[first_green_sha_ind][0]
    first_red = categorized_shas[first_red_sha_ind][0]

    print(
        f"The first green SHA was at index {first_green_sha_ind} at {first_green['sha']}"
        + f"and the first red SHA was at index {first_red_sha_ind} at {first_red['sha']}"
    )
    if first_green < 0:
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


def main():
    job_names, sha_grid = fetch_hud_data()
    (jobs_to_alert_on, flaky_jobs) = classify_jobs(job_names, sha_grid)

    # DO GITHUB STUFF
    alerts = fetch_alerts()
    alerts_cleared = False
    # # Try to clear the alerts
    if should_clear_alerts(sha_grid):
        alerts_cleared = clear_alerts(alerts)

    no_alert_currently_active = alerts_cleared == True or len(alerts) == 0
    if len(jobs_to_alert_on) > 0 and (no_alert_currently_active):
        create_issue(generate_failed_job_issue(jobs_to_alert_on))

    # TODO: Record flaky jobs in rockset or something re run or analyze


if __name__ == "__main__":
    main()
