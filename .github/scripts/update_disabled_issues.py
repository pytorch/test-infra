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
from typing import Any, cast, Dict, List, Optional, Tuple
from urllib.request import Request, urlopen


DISABLED_PREFIX = "DISABLED"
UNSTABLE_PREFIX = "UNSTABLE"
DISABLED_TEST_ISSUE_TITLE = re.compile(r"DISABLED\s*test_.+\s*\(.+\)")
DISABLED_TEST_MULTI_ISSUE_TITLE = re.compile(r"DISABLED MULTIPLE")
JOB_NAME_MAXSPLIT = 2

OWNER = "pytorch"
REPO = "pytorch"

PERMISSIONS_TO_DISABLE_JOBS = {"admin", "write"}

GRAPHQL_QUERY = """
query ($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    issueCount
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on Issue {
        number
        title
        body
        url
        author {
          login
        }
      }
    }
  }
}
"""


def github_api_request(
    url: str,
    data: Optional[Dict[str, Any]] = None,
    token: Optional[str] = None,
) -> Any:
    headers = {"Accept": "application/vnd.github.v3+json"}
    if token is not None:
        headers["Authorization"] = f"token {token}"

    _data = json.dumps(data).encode() if data is not None else None
    try:
        with urlopen(Request(url, headers=headers, data=_data)) as conn:
            return json.load(conn)
    except Exception as err:
        print(f"Failed to get {url}: {err}")


def gh_graphql(query: str, token: str, **kwargs: Any) -> Dict[str, Any]:
    rc = github_api_request(
        "https://api.github.com/graphql",
        data={"query": query, "variables": kwargs},
        token=token,
    )
    if "errors" in rc:
        raise RuntimeError(
            f"GraphQL query {query}, args {kwargs} failed: {rc['errors']}"
        )
    return cast(Dict[str, Any], rc)


@lru_cache()
def get_disable_issues(
    token: str, prefix: str = DISABLED_PREFIX
) -> List[Dict[str, Any]]:
    q = f"is:issue is:open repo:{OWNER}/{REPO} in:title {prefix}"
    cursor = None
    has_next_page = True
    res = []
    total_count = None
    while has_next_page:
        rc = gh_graphql(GRAPHQL_QUERY, token, q=q, cursor=cursor)
        has_next_page = rc["data"]["search"]["pageInfo"]["hasNextPage"]
        cursor = rc["data"]["search"]["pageInfo"]["endCursor"]
        if total_count is None:
            total_count = rc["data"]["search"]["issueCount"]
        else:
            assert (
                total_count == rc["data"]["search"]["issueCount"]
            ), "total_count changed"
        res.extend(rc["data"]["search"]["nodes"])

    assert (
        len(res) == total_count
    ), f"len(items)={len(res)} but total_count={total_count}"
    res = sorted(res, key=lambda x: x["url"])
    return res


def filter_disable_issues(
    issues: List[Dict[str, Any]], prefix: str = DISABLED_PREFIX
) -> Tuple[List[Any], List[Any]]:
    """
    Return the list of disabled test and disabled job issues
    """
    disable_test_issues = []
    disable_job_issues = []

    for issue in issues:
        title = issue["title"]
        if not title or not title.startswith(prefix):
            continue

        if DISABLED_TEST_ISSUE_TITLE.match(
            title
        ) or DISABLED_TEST_MULTI_ISSUE_TITLE.match(title):
            disable_test_issues.append(issue)
        else:
            disable_job_issues.append(issue)

    return disable_test_issues, disable_job_issues


def get_disabled_tests(issues: List[Dict[str, Any]]) -> Dict[str, Tuple]:
    def get_platforms_to_skip(body: str, prefix: str) -> List[str]:
        # Empty list = all platforms should skip the test
        platforms_to_skip = []
        if body is not None:
            for line in body.splitlines():
                line = line.lower()
                if line.startswith(prefix):
                    platforms_to_skip.extend(
                        [x.strip() for x in line[len(prefix) :].split(",") if x.strip()]
                    )
        return platforms_to_skip

    disabled_tests = {}

    def update_disabled_tests(
        key: str, number: str, url: str, platforms_to_skip: List[str]
    ):
        # merge the list of platforms to skip if the test is disabled by
        # multiple issues.  This results in some urls being wrong
        if key not in disabled_tests:
            disabled_tests[key] = (number, url, platforms_to_skip)
        else:
            original_platforms = disabled_tests[key][2]
            if len(original_platforms) == 0 or len(platforms_to_skip) == 0:
                platforms = []
            else:
                platforms = sorted(set(original_platforms + platforms_to_skip))
            disabled_tests[key] = (
                number,
                url,
                platforms,
            )

    test_name_regex = re.compile(r"(test_[a-zA-Z0-9-_\.]+)\s+\(([a-zA-Z0-9-_\.]+)\)")

    def parse_test_name(s: str) -> Optional[str]:
        test_name_match = test_name_regex.match(s)
        if test_name_match:
            return f"{test_name_match.group(1)} ({test_name_match.group(2)})"
        return None

    for issue in issues:
        try:
            url = issue["url"]
            number = url.split("/")[-1]
            title = issue["title"].strip()
            body = issue["body"]

            test_name = parse_test_name(title[len("DISABLED") :].strip())
            if test_name is not None:
                update_disabled_tests(
                    test_name, number, url, get_platforms_to_skip(body, "platforms:")
                )
            elif DISABLED_TEST_MULTI_ISSUE_TITLE.match(title):
                # This is a multi-test issue
                start = body.lower().find("disable the following tests:")
                # Format for disabling tests:
                # Title: DISABLED MULTIPLE anything
                # disable the following tests:
                # ```
                # test_name1 (test_suite1): mac, windows
                # test_name2 (test_suite2): mac, windows
                # ```
                for line in body[start:].splitlines()[2:]:
                    if "```" in line:
                        break
                    split_by_colon = line.split(":")

                    test_name = parse_test_name(split_by_colon[0].strip())
                    if test_name is None:
                        continue
                    update_disabled_tests(
                        test_name,
                        number,
                        url,
                        get_platforms_to_skip(
                            split_by_colon[1].strip()
                            if len(split_by_colon) > 1
                            else "",
                            "",
                        ),
                    )
            else:
                print(f"Unknown disable issue type: {title}")
        except Exception as e:
            print(f"Failed to parse issue {issue['url']}: {e}")
            continue

    return disabled_tests


@lru_cache()
def can_disable_jobs(owner: str, repo: str, username: str, token: str) -> bool:
    url = f"https://api.github.com/repos/{owner}/{repo}/collaborators/{username}/permission"

    try:
        perm = github_api_request(url=url, token=token)
    except urllib.error.HTTPError as error:
        print(f"Failed to get {owner}/{repo} permission for {username}: {error}")
        return False

    if not perm:
        return False

    return perm and perm.get("permission", "").lower() in PERMISSIONS_TO_DISABLE_JOBS


def condense_disable_jobs(
    disable_issues: List[Any],
    owner: str,
    repo: str,
    token: str,
    prefix: str = DISABLED_PREFIX,
) -> Dict[str, Tuple]:
    disabled_job_from_issues = {}
    for item in disable_issues:
        issue_url = item["url"]
        issue_number = issue_url.split("/")[-1]

        title = item["title"]
        job_name = title[len(prefix) :].strip()

        if not job_name:
            continue

        username = item["author"]["login"]
        # To keep the CI safe, we will only allow author with write permission
        # to the repo to disable jobs
        if not username or not can_disable_jobs(
            owner=owner, repo=repo, username=username, token=token
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
    token = os.getenv("GITHUB_TOKEN")
    if not token:
        raise RuntimeError("The GITHUB_TOKEN environment variable is required")

    # Get the list of disabled issues and sort them
    disable_issues = get_disable_issues(token)

    disable_test_issues, disable_job_issues = filter_disable_issues(disable_issues)
    # Create the list of disabled tests taken into account the list of disabled issues
    # and those that are not flaky anymore
    dump_json(get_disabled_tests(disable_test_issues), "disabled-tests-condensed.json")
    dump_json(
        condense_disable_jobs(disable_job_issues, args.owner, args.repo, token),
        "disabled-jobs.json",
    )

    # Also handle UNSTABLE issues that mark CI jobs as unstable
    unstable_issues = get_disable_issues(token, prefix=UNSTABLE_PREFIX)

    _, unstable_job_issues = filter_disable_issues(
        unstable_issues, prefix=UNSTABLE_PREFIX
    )
    dump_json(
        condense_disable_jobs(
            unstable_job_issues,
            args.owner,
            args.repo,
            token,
            prefix=UNSTABLE_PREFIX,
        ),
        "unstable-jobs.json",
    )


if __name__ == "__main__":
    main()
