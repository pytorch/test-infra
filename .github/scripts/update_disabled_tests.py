#!/usr/bin/env python3
"""
Query for the DISABLED test issues and check if they are still flaky
"""

import argparse
import json
import os
from functools import lru_cache
from typing import Any, Dict, List
from urllib.request import Request, urlopen

from rockset import Client

# Modified from https://github.com/pytorch/pytorch/blob/b00206d4737d1f1e7a442c9f8a1cadccd272a386/torch/hub.py#L129


def _read_url(url: Any) -> Any:
    with urlopen(url) as r:
        return r.headers, r.read().decode(r.headers.get_content_charset("utf-8"))


def request_for_labels(url: str) -> Any:
    headers = {"Accept": "application/vnd.github.v3+json"}
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
def get_disable_issues() -> Dict[Any, Any]:
    prefix = (
        "https://api.github.com/search/issues?q=is%3Aissue+is%3Aopen+repo:pytorch/pytorch+in%3Atitle+DISABLED&"
        "&per_page=100"
    )
    header, info = request_for_labels(prefix + "&page=1")
    issues_json = json.loads(info)
    last_page = get_last_page(header)
    assert (
        last_page > 0
    ), "Error reading header info to determine total number of pages of labels"
    for page_number in range(2, last_page + 1):  # skip page 1
        _, info = request_for_labels(prefix + f"&page={page_number}")
        update_issues(issues_json, info)

    return issues_json


def validate_and_sort(issues_json: Dict[str, Any]) -> None:
    assert issues_json["total_count"] == len(issues_json["items"]), (
        f"The number of issues does not equal the total count. Received {len(issues_json['items'])}, "
        f"while the total count is {issues_json['total_count']}."
    )
    assert not issues_json[
        "incomplete_results"
    ], f"Results were incomplete. There may be missing issues."

    # score changes every request, so we strip it out to avoid creating a commit every time we query.
    for issue in issues_json["items"]:
        if "score" in issue:
            issue["score"] = 0.0

    issues_json["items"].sort(key=lambda x: x["url"])


def condense_disable_issues(
    disable_issues: Dict[Any, Any],
    non_flaky_disabled_tests: Dict[str, Dict[str, Any]],
    dry_run: bool,
):
    disabled_test_from_issues = dict()
    for item in disable_issues["items"]:
        title = item["title"]
        key = "DISABLED "
        issue_url = item["html_url"]
        issue_number = issue_url.split("/")[-1]
        if title.startswith(key):
            test_name = title[len(key) :].strip()

            if test_name in non_flaky_disabled_tests:
                # Not running under dry-run mode, the script is allowed to skip non flaky tests
                if not dry_run:
                    # TODO: see if we can close the issue right here or if it needs to be done
                    # elsewhere with sufficient permission
                    continue

                num_green = non_flaky_disabled_tests[test_name].get("num_green", 0)
                # Only report the result in dry-run mode
                print(
                    f"{test_name} is not flaky after {num_green} reruns, {issue_url} can be closed"
                )

            body = item["body"]
            platforms_to_skip = []
            key = "platforms:"
            # When the issue has no body, it is assumed that all platforms should skip the test
            if body is not None:
                for line in body.splitlines():
                    line = line.lower()
                    if line.startswith(key):
                        platforms_to_skip.extend(
                            [
                                x.strip()
                                for x in line[len(key) :].split(",")
                                if x.strip()
                            ]
                        )

            disabled_test_from_issues[test_name] = (
                issue_number,
                issue_url,
                platforms_to_skip,
            )

    with open("disabled-tests-condensed.json", mode="w") as file:
        json.dump(disabled_test_from_issues, file, sort_keys=True, indent=2)


def query_non_flaky_disabled_tests() -> Dict[str, Dict[str, Any]]:
    """
    Get the list of all non flaky tests that are still disabled
    """
    rs = Client(
        api_server="api.rs2.usw2.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    )
    qlambda = rs.QueryLambda.retrieve(
        "disabled_non_flaky_tests", version="8c6281756c969663", workspace="commons"
    )

    try:
        response = qlambda.execute()
    except rockset.exception.Error as e:
        print(f"WARNING: Fail to query non flaky disabled test from Rockset: {e}")
        return []

    results: Dict[str, Any] = {}
    for record in response.get("results"):
        name = record.get("name")
        classname = record.get("classname")
        # Format the test name in the same way as the disabled issue
        test_name = f"{name} (__main__.{classname})"
        results[test_name] = record

    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Update the list of disabled tests")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run in dry run mode and avoid making changes to the output JSON",
    )
    args = parser.parse_args()

    # Get the list of disabled issues and sort them
    disable_issues = get_disable_issues()
    validate_and_sort(disable_issues)

    # Query the list of non flaky disabled tests, so that they can be skipped. The
    # list will only take into account reports that are newer than 1 day (no stale)
    # with absolutely no red signal and having more than 50 green rerun signals
    non_flaky_disabled_tests = query_non_flaky_disabled_tests()

    # Create the list of disabled tests taken into account the list of disabled issues
    # and those that are not flaky anymore
    condense_disable_issues(disable_issues, non_flaky_disabled_tests, args.dry_run)


if __name__ == "__main__":
    main()
