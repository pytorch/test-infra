#!/usr/bin/env python3

import argparse
import json
import os
import re
import urllib.parse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Any, Dict, List, Optional, Set, Tuple

import requests
from setuptools import distutils  # type: ignore[import]

from torchci.utils import fake_browser_headers


FAILURE_CHAIN_THRESHOLD = 2
FAILED_JOB_PATTERN = r"^- \[(.*)\]\(.*\)$"
# Max number of comments on a Github issue is 2500, so we stop early to avoid
# hitting that limit
SOFT_COMMENT_THRESHOLD = 2400

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
        comments(first: 0) {
          totalCount
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

JOB_NAME_REGEX = re.compile(r"^(.* \([^,]*), \d.*\)$")


class JobConclusion(StrEnum):
    PENDING = "pending"
    FAILURE = "failure"
    SUCCESS = "success"
    NEUTRAL = "neutral"
    SKIPPED = "skipped"
    CANCELED = "canceled"


class JobData:
    conclusion: Optional[JobConclusion]
    job_name: str
    job_name_no_shard: str

    def __init__(self, job_name: str, job_data: Dict[str, Any]):
        self.job_name = job_name
        self.conclusion = job_data.get("conclusion", None)

        # Go from "job_name (config, 1...)" to "job_name (config)" if applicable
        match = JOB_NAME_REGEX.match(job_name)
        if match is not None:
            self.job_name_no_shard = f"{match.group(1)})"
        else:
            self.job_name_no_shard = job_name

    def is_failed(self) -> bool:
        """
        Returns True if the job is failed, i.e. has a conclusion of FAILURE or is canceled.
        """
        return self.conclusion is not None and self.conclusion == JobConclusion.FAILURE

    def is_skipped(self) -> bool:
        """
        Returns True if the job is skipped, i.e. has a conclusion of NEUTRAL or SKIPPED.
        """
        return self.conclusion is not None and (
            self.conclusion == JobConclusion.NEUTRAL
            or self.conclusion == JobConclusion.SKIPPED
        )

    def __repr__(self) -> str:
        return f"JobData(job_name={self.job_name}, conclusion={self.conclusion})"


class JobGroup:
    """
    Represents a group of jobs that should be considered together, e.g. all
    shards of a job.  The list of jobs can be seen as a set, but I don't want to
    go through the trouble of making JobData hashable.
    """

    jobs = list[JobData]

    def __init__(self, jobs: list[JobData]):
        self.jobs = jobs

    def is_successful(self) -> bool:
        """
        Returns True if all jobs in this group are successful, i.e. have a conclusion of SUCCESS.
        """
        return all(job.conclusion == JobConclusion.SUCCESS for job in self.jobs)

    def any_pending(self) -> bool:
        """
        Returns True if any job in this group is pending, i.e. has a conclusion of PENDING.
        """
        return any(job.conclusion == JobConclusion.PENDING for job in self.jobs)

    def is_failing(self) -> bool:
        """
        Returns True if any job in this group is failing, i.e. has a conclusion of FAILURE.
        """
        return any(job.conclusion == JobConclusion.FAILURE for job in self.jobs)

    def __repr__(self) -> str:
        return f"JobGroup(jobs={self.jobs})"


class JobStatus:
    job_name: str
    job_statuses: list[JobGroup]

    def __init__(self, job_name: str, job_statuses: list[JobGroup]):
        self.job_name = job_name
        self.job_statuses = job_statuses

    def should_alert(self) -> bool:
        """
        Returns True if the job is currently failing, i.e. has a failure in the most recent status.
        """
        chain_length = 0
        for job_group in self.job_statuses:
            if job_group.is_successful():
                break
            if job_group.is_failing():
                chain_length += 1
            # If anything is pending, skipped, or neutral, we act like it's not
            # there because it could be a schrodingers failure

        return chain_length >= FAILURE_CHAIN_THRESHOLD

    def __repr__(self) -> str:
        return f"jobName: {self.job_name}"


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


def fetch_alerts_filter(repo: str, branch: str, labels: List[str]) -> List[Any]:
    alerts = fetch_alerts(labels)
    return [
        alert
        for alert in alerts
        if f"Recurrently Failing Jobs on {repo} {branch}" in alert["title"]
    ]


def close_if_too_many_comments(issue: Dict[str, Any], dry_run: bool) -> bool:
    """Close the issue if it has too many comments. Return True if there are too many comments."""
    if issue["comments"]["totalCount"] > SOFT_COMMENT_THRESHOLD:
        if not issue["closed"]:
            print(f"Closing issue #{issue['number']} due to too many comments")
            if dry_run:
                print("NOTE: Dry run, not doing any real work")
                return True
            r = requests.post(
                f"https://api.github.com/repos/{REPO_OWNER}/{TEST_INFRA_REPO_NAME}/issues/{issue['number']}/comments",
                data=json.dumps({"body": "Closing due to too many comments"}),
                headers=headers,
            )
            r.raise_for_status()
            r = requests.patch(
                UPDATE_ISSUE_URL + str(issue["number"]),
                json={"state": "closed"},
                headers=headers,
            )
            r.raise_for_status()
        return True
    return False


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


def generate_failed_job_hud_link(failed_job: JobStatus) -> str:
    # TODO: Handle other branches/repos
    hud_link = f"https://hud.pytorch.org/hud/pytorch/pytorch/main/1?per_page=100&name_filter={urllib.parse.quote(failed_job.job_name)}&mergeEphemeralLF=true"
    return f"[{failed_job.job_name}]({hud_link})"


def generate_failed_job_issue(
    repo: str, branch: str, failed_jobs: List[JobStatus]
) -> Any:
    failed_jobs.sort(key=lambda status: status.job_name)
    issue = {}
    issue["title"] = (
        f"[Pytorch] There are {len(failed_jobs)} Recurrently Failing Jobs on {repo} {branch}"
    )
    body = "Within the last 50 commits, there are the following failures on the main branch of pytorch: \n"
    for job in failed_jobs:
        body += f"- {generate_failed_job_hud_link(job)}\n"

    body += "Please review the errors and revert if needed."
    issue["body"] = body
    issue["labels"] = [PYTORCH_ALERT_LABEL]
    issue["state"] = "open"

    print("Generating alerts for: ", failed_jobs)
    return issue


def gen_update_comment(original_issue: Dict[str, Any], jobs: List[JobStatus]) -> str:
    """
    Returns empty string if nothing signficant changed. Otherwise returns a
    short string meant for updating the issue.
    """
    original_jobs = []
    if not original_issue["closed"]:
        for line in original_issue["body"].splitlines():
            match = re.match(FAILED_JOB_PATTERN, line.strip())
            if match is not None:
                original_jobs.append(match.group(1))

    new_jobs = [job.job_name for job in jobs]
    stopped_failing_jobs = [job for job in original_jobs if job not in new_jobs]
    started_failing_jobs = [job for job in new_jobs if job not in original_jobs]

    # TODO: Add real HUD links to these eventually since not having clickable links is bad
    s = ""
    if len(stopped_failing_jobs) > 0:
        s += "These jobs stopped failing:\n"
        for job in stopped_failing_jobs:
            s += f"* {job}\n"
        s += "\n"
    if len(started_failing_jobs) > 0:
        s += "These jobs started failing:\n"
        for job in started_failing_jobs:
            s += f"* {job}\n"
    return s.rstrip()


def generate_no_flaky_tests_issue() -> Any:
    issue = {}
    issue["title"] = (
        f"[Pytorch][Warning] No flaky test issues have been detected in the past {FLAKY_TESTS_SEARCH_PERIOD_DAYS} days!"
    )
    issue["body"] = (
        f"No issues have been filed in the past {FLAKY_TESTS_SEARCH_PERIOD_DAYS} days for "
        f"the repository {REPO_OWNER}/{TEST_INFRA_REPO_NAME}.\n"
        "This can be an indication that the flaky test bot has stopped filing tests."
    )
    issue["labels"] = [NO_FLAKY_TESTS_LABEL]

    return issue


def update_issue(
    issue: Dict, old_issue: Any, update_comment: str, dry_run: bool
) -> None:
    print(f"Updating issue {issue} with content:{os.linesep}{update_comment}")
    if dry_run:
        print("NOTE: Dry run, not doing any real work")
        return
    r = requests.patch(
        UPDATE_ISSUE_URL + str(old_issue["number"]), json=issue, headers=headers
    )
    r.raise_for_status()
    r = requests.post(
        f"https://api.github.com/repos/{REPO_OWNER}/{TEST_INFRA_REPO_NAME}/issues/{old_issue['number']}/comments",
        data=json.dumps({"body": update_comment}),
        headers=headers,
    )
    r.raise_for_status()


def create_issue(issue: Dict, dry_run: bool) -> Dict:
    print(f"Creating issue with content:{os.linesep}{issue}")
    if dry_run:
        print("NOTE: Dry run activated, not doing any real work")
        return {"number": -1, "closed": False, "body": ""}
    r = requests.post(CREATE_ISSUE_URL, json=issue, headers=headers)
    r.raise_for_status()
    res = r.json()
    return {"number": res["number"], "closed": False, "body": res["body"]}


def fetch_hud_data(repo: str, branch: str) -> Tuple[List[str], list[list[JobData]]]:
    response = requests.get(
        f"https://hud.pytorch.org/api/hud/{repo}/{branch}/0",
        headers=fake_browser_headers(),
    )
    response.raise_for_status()
    hud_data = json.loads(response.text)

    job_names = hud_data["jobNames"]
    # Do the conversion into classes here so we don't have to worry about it
    # later.  Lost sha info but we don't need it atm.  Commit order is list
    # order
    sha_grid = []
    for row in hud_data["shaGrid"]:
        jobs: list[JobData] = []
        for ind, job in enumerate(row["jobs"]):
            job_name = job_names[ind]
            if len(job) == 0:
                # Job is a dict but for historical reasons if its an empty dict
                # it means there is no job
                continue
            jobs.append(JobData(job_name, job))
        sha_grid.append(jobs)
    return (hud_data["jobNames"], sha_grid)


def map_job_data(
    shaGrid: list[list[JobData]], filteredJobsNames: Set[str]
) -> dict[str, list[JobGroup]]:
    """
    The result is a dictionary mapping job names without shard info -> list of
    JobGroup.  The JobGroup list is grouped according to SHA and the order is
    according to recency of the SHA
    """
    jobData: dict[str, list[list[JobData]]] = defaultdict(list)
    for row in shaGrid:
        # First group by job name (no shard info) within a row
        row_job_name_mapping: dict[str, list[JobData]] = defaultdict(list)
        for job in row:
            if job.job_name not in filteredJobsNames:
                continue
            row_job_name_mapping[job.job_name_no_shard].append(job)

        # Then add to the list as one group to preserve the order
        for job_name, jobs in row_job_name_mapping.items():
            if job_name not in jobData:
                jobData[job_name] = []
            jobData[job_name].append(JobGroup(jobs))
    return jobData


def clear_alerts(alerts: List[Any], dry_run: bool) -> bool:
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


def classify_jobs(
    sha_grid: list[list[JobData]], filtered_jobs_names: Set[str]
) -> List[JobStatus]:
    """
    Creates Job Statuses which has the logic for if need to alert/
    """
    job_data = map_job_data(sha_grid, filtered_jobs_names)
    job_statuses: list[JobStatus] = []
    for job in job_data:
        job_statuses.append(JobStatus(job, job_data[job]))

    return [job_status for job_status in job_statuses if job_status.should_alert()]


def handle_flaky_tests_alert(
    existing_alerts: List[Dict], dry_run: bool = False
) -> Dict:
    if not existing_alerts:
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
            return create_issue(generate_no_flaky_tests_issue(), dry_run=dry_run)

    print("No new alert for flaky tests bots.")
    return None


# filter job names that don't match the regex
def filter_job_names(job_names: List[str], job_name_regex: str) -> List[str]:
    if job_name_regex:
        return [
            job_name
            for job_name in job_names
            if re.match(job_name_regex, job_name, re.IGNORECASE)
        ]
    return job_names


def check_for_recurrently_failing_jobs_alert(
    repo: str, branch: str, job_name_regex: str, dry_run: bool
):
    job_names, sha_grid = fetch_hud_data(repo=repo, branch=branch)
    print(f"Found {len(job_names)} jobs for {repo} {branch} branch:")
    print("\n".join(job_names))

    filtered_job_names = set(filter_job_names(job_names, job_name_regex))
    if job_name_regex:
        print()
        print(f"Filtered to {len(filtered_job_names)} jobs:")
        if len(filtered_job_names) == 0:
            print("No jobs matched the regex")
        elif len(filtered_job_names) == len(job_names):
            print("All jobs matched the regex")
        else:
            print("\n".join(sorted(filtered_job_names)))

    jobs_to_alert_on = classify_jobs(sha_grid, filtered_job_names)

    # Fetch alerts
    existing_alerts = fetch_alerts_filter(
        repo=repo,
        branch=branch,
        labels=PYTORCH_ALERT_LABEL,
    )

    # Auto-clear any existing alerts if the current status is green
    if len(jobs_to_alert_on) == 0:
        print(f"Didn't find anything to alert on for {repo} {branch}")
        clear_alerts(existing_alerts, dry_run=dry_run)
        return

    # If the issue has too many comments, we should close it and open a new one
    existing_alerts = [
        x for x in existing_alerts if not close_if_too_many_comments(x, dry_run)
    ]

    if len(existing_alerts) == 0:
        # Generate a blank issue if there are no issues so we can post an update
        # comment, which will trigger a more informative workchat ping
        new_issue = create_issue(
            generate_failed_job_issue(repo=repo, branch=branch, failed_jobs=[]), dry_run
        )
        existing_alerts.append(new_issue)

    # Always favor the most recent issue, close all other ones
    existing_issue = existing_alerts[-1]
    clear_alerts(existing_alerts[:-1], dry_run)

    update_comment = gen_update_comment(existing_issue, jobs_to_alert_on)

    if update_comment:
        new_issue = generate_failed_job_issue(
            repo=repo, branch=branch, failed_jobs=jobs_to_alert_on
        )
        update_issue(new_issue, existing_issue, update_comment, dry_run=dry_run)
    else:
        print(f"No new change. Not updating any alert for {repo} {branch}")


def check_for_no_flaky_tests_alert(repo: str, branch: str):
    existing_no_flaky_tests_alerts = fetch_alerts(
        labels=[NO_FLAKY_TESTS_LABEL],
    )
    open_alerts = [
        alert for alert in existing_no_flaky_tests_alerts if not alert["closed"]
    ]
    recent_open_alerts = [
        existing_alert
        for existing_alert in open_alerts
        if datetime.now(timezone.utc)
        - datetime.fromisoformat(existing_alert["createdAt"].replace("Z", "+00:00"))
        < timedelta(days=7)
    ]
    handle_flaky_tests_alert(recent_open_alerts)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--repo",
        help="Repository to do checks for",
        type=str,
        default=os.getenv("REPO_TO_CHECK", "pytorch/pytorch"),
    )
    parser.add_argument(
        "--branch",
        help="Branch to do checks for",
        type=str,
        default=os.getenv("BRANCH_TO_CHECK", "main"),
    )
    parser.add_argument(
        "--job-name-regex",
        help="Consider only job names matching given regex (if omitted, all jobs are matched)",
        type=str,
        default=os.getenv("JOB_NAME_REGEX", ""),
    )
    parser.add_argument(
        "--with-flaky-test-alert",
        help="Run this script with the flaky test alerting",
        type=distutils.util.strtobool,
        default=os.getenv("WITH_FLAKY_TEST_ALERT", "NO"),
    )
    parser.add_argument(
        "--dry-run",
        help="Whether or not to actually post issues",
        type=distutils.util.strtobool,
        default=os.getenv("DRY_RUN", "YES"),
    )
    return parser.parse_args()


def main():
    args = parse_args()
    check_for_recurrently_failing_jobs_alert(
        args.repo, args.branch, args.job_name_regex, args.dry_run
    )
    # TODO: Fill out dry run for flaky test alerting, not going to do in one PR
    if args.with_flaky_test_alert:
        check_for_no_flaky_tests_alert(args.repo, args.branch)


if __name__ == "__main__":
    main()
