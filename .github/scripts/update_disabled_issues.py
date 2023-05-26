#!/usr/bin/env python3
"""
Query for the DISABLED and UNSTABLE issues and check:
  * if they are still flaky for disabled tests
  * if they are to disable workflow jobs
  * if they are to mark workflow jobs as unstable
"""

import argparse
import json
import os
import re
import urllib
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple
from urllib.request import Request, urlopen


DISABLED_PREFIX = "DISABLED"
UNSTABLE_PREFIX = "UNSTABLE"
DISABLED_TEST_ISSUE_TITLE = re.compile(r"DISABLED\s*test_.+\s*\(.+\)")
JOB_NAME_MAXSPLIT = 2

OWNER = "pytorch"
REPO = "pytorch"

PERMISSIONS_TO_DISABLE_JOBS = {"admin", "write"}


def _read_url(url: Any) -> Any:
    with urlopen(url) as r:
        return r.headers, r.read().decode(r.headers.get_content_charset("utf-8"))


def github_api_request(url: str, token: Optional[str] = "") -> Any:
    headers = {"Accept": "application/vnd.github.v3+json"}

    if token:
        headers["Authorization"] = f"token {token}"

    return _read_url(Request(url, headers=headers))


def get_last_page(header: Any) -> int:
    # Link info looks like:
    # Link: <https://api.github.com/search/issues?q=is%3Aissue+is%3Aopen+repo%3Apytorch%2Fpytorch+in%3Atitle+
    # DISABLED&per_page=30&page=2>; rel="next", <https://api.github.com/search/issues?q=is%3Aissue+is%3Aopen+
    # repo%3Apytorch%2Fpytorch+in%3Atitle+DISABLED&per_page=30&page=4>; rel="last"
    link_info = header["link"]
    if link_info is None:
        print(
            "WARNING: Link information missing, most likely because there is only one page of results."
        )
        return 1
    prefix = "&page="
    suffix = ">;"
    return int(
        link_info[link_info.rindex(prefix) + len(prefix) : link_info.rindex(suffix)]
    )


def update_issues(issues_json: Dict[Any, Any], info: str) -> None:
    more_issues = json.loads(info)
    issues_json["items"].extend(more_issues["items"])
    issues_json["incomplete_results"] |= more_issues["incomplete_results"]


@lru_cache()
def get_disable_issues(prefix: str = DISABLED_PREFIX) -> Dict[Any, Any]:
    prefix = (
        f"https://api.github.com/search/issues?q=is%3Aissue+is%3Aopen+repo:{OWNER}/{REPO}+in%3Atitle+{prefix}&"
        "&per_page=100"
    )
    header, info = github_api_request(prefix + "&page=1")
    issues_json = json.loads(info)
    last_page = get_last_page(header)
    assert (
        last_page > 0
    ), "Error reading header info to determine total number of pages of labels"
    for page_number in range(2, last_page + 1):  # skip page 1
        _, info = github_api_request(prefix + f"&page={page_number}")
        update_issues(issues_json, info)

    return issues_json


def validate_and_sort(issues_json: Dict[str, Any]) -> None:
    assert issues_json["total_count"] == len(issues_json["items"]), (
        f"The number of issues does not equal the total count. Received {len(issues_json['items'])}, "
        f"while the total count is {issues_json['total_count']}."
    )
    assert not issues_json[
        "incomplete_results"
    ], "Results were incomplete. There may be missing issues."

    # score changes every request, so we strip it out to avoid creating a commit every time we query.
    for issue in issues_json["items"]:
        if "score" in issue:
            issue["score"] = 0.0

    issues_json["items"].sort(key=lambda x: x["url"])


def filter_disable_issues(
    issues_json: Dict[str, Any], prefix: str = DISABLED_PREFIX
) -> Tuple[List[Any], List[Any]]:
    """
    Return the list of disabled test and disabled job issues
    """
    disable_test_issues = []
    disable_job_issues = []

    for issue in issues_json.get("items", []):
        title = issue.get("title", "")
        if not title or not title.startswith(prefix):
            continue

        if DISABLED_TEST_ISSUE_TITLE.match(title):
            disable_test_issues.append(issue)
        else:
            disable_job_issues.append(issue)

    return disable_test_issues, disable_job_issues


@lru_cache()
def can_disable_jobs(owner: str, repo: str, username: str) -> bool:
    token = os.getenv("GH_PYTORCHBOT_TOKEN", "")
    url = f"https://api.github.com/repos/{owner}/{repo}/collaborators/{username}/permission"

    try:
        _, r = github_api_request(url=url, token=token)
    except urllib.error.HTTPError as error:
        print(f"Failed to get {owner}/{repo} permission for {username}: {error}")
        return False

    if not r:
        return False
    perm = json.loads(r)

    return perm and perm.get("permission", "").lower() in PERMISSIONS_TO_DISABLE_JOBS


def condense_disable_tests(
    disable_issues: List[Any],
) -> Dict[str, Tuple]:
    disabled_test_from_issues = {}
    for item in disable_issues:
        issue_url = item["html_url"]
        issue_number = issue_url.split("/")[-1]

        title = item["title"]
        test_name = title[len(DISABLED_PREFIX) :].strip()

        body = item["body"]
        platforms_to_skip = []
        key = "platforms:"
        # When the issue has no body, it is assumed that all platforms should skip the test
        if body is not None:
            for line in body.splitlines():
                line = line.lower()
                if line.startswith(key):
                    platforms_to_skip.extend(
                        [x.strip() for x in line[len(key) :].split(",") if x.strip()]
                    )

        disabled_test_from_issues[test_name] = (
            issue_number,
            issue_url,
            platforms_to_skip,
        )

    return disabled_test_from_issues


def condense_disable_jobs(
    disable_issues: List[Any],
    owner: str,
    repo: str,
    prefix: str = DISABLED_PREFIX,
) -> Dict[str, Tuple]:
    disabled_job_from_issues = {}
    for item in disable_issues:
        issue_url = item["html_url"]
        issue_number = issue_url.split("/")[-1]

        title = item["title"]
        job_name = title[len(prefix) :].strip()

        if not job_name:
            continue

        username = item.get("user", {}).get("login", "")
        # To keep the CI safe, we will only allow author with write permission
        # to the repo to disable jobs
        if not username or not can_disable_jobs(
            owner=owner, repo=repo, username=username
        ):
            continue

        parts = job_name.split("/", JOB_NAME_MAXSPLIT)
        # Split the job name into workflow, platform, and configuration names
        # For example, pull / linux-bionic-py3.8-clang9 / test (dynamo) name
        # include the following 3 parts: pull (job name), linux-bionic-py3.8-clang9
        # (platform name), and test (dynamo) (configuration name)
        workflow_name = parts[0].strip() if parts else ""
        platform_name = parts[1].strip() if len(parts) >= 2 else ""
        config_name = parts[2].strip() if len(parts) >= 3 else ""

        disabled_job_from_issues[job_name] = (
            username,
            issue_number,
            issue_url,
            workflow_name,
            platform_name,
            config_name,
        )

    return disabled_job_from_issues


def dump_json(data: Dict[str, Any], filename: str):
    with open(filename, mode="w") as file:
        json.dump(data, file, sort_keys=True, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(description="Update the list of disabled tests")
    parser.add_argument(
        "--owner",
        default=OWNER,
        help="Set the repo owner to query the issues from",
    )
    parser.add_argument(
        "--repo",
        default=REPO,
        help="Set the repo to query the issues from",
    )
    args = parser.parse_args()

    # Get the list of disabled issues and sort them
    disable_issues = get_disable_issues()
    validate_and_sort(disable_issues)

    disable_test_issues, disable_job_issues = filter_disable_issues(disable_issues)
    # Create the list of disabled tests taken into account the list of disabled issues
    # and those that are not flaky anymore
    dump_json(
        condense_disable_tests(disable_test_issues), "disabled-tests-condensed.json"
    )
    dump_json(
        condense_disable_jobs(disable_job_issues, args.owner, args.repo),
        "disabled-jobs.json",
    )

    # Also handle UNSTABLE issues that mars CI jobs as unstable
    unstable_issues = get_disable_issues(prefix=UNSTABLE_PREFIX)
    validate_and_sort(unstable_issues)

    _, unstable_job_issues = filter_disable_issues(
        unstable_issues, prefix=UNSTABLE_PREFIX
    )
    dump_json(
        condense_disable_jobs(
            unstable_job_issues, args.owner, args.repo, prefix=UNSTABLE_PREFIX
        ),
        "unstable-jobs.json",
    )


if __name__ == "__main__":
    main()
