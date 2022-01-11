#!/usr/bin/env python3
"""
Query for the DISABLED test issues.

"""

import json
from functools import lru_cache
from typing import Any, Dict
from urllib.request import urlopen, Request

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
        print("WARNING: Link information missing, most likely because there is only one page of results.")
        return 1
    prefix = "&page="
    suffix = ">;"
    return int(link_info[link_info.rindex(prefix) + len(prefix):link_info.rindex(suffix)])


def update_issues(issues_json: Dict[Any, Any], info: str) -> None:
    more_issues = json.loads(info)
    issues_json["items"].extend(more_issues["items"])
    issues_json["incomplete_results"] &= more_issues["incomplete_results"]
    issues_json["total_count"] += more_issues["total_count"]


@lru_cache()
def get_disable_issues() -> Dict[Any, Any]:
    prefix = "https://api.github.com/search/issues?q=is%3Aissue+is%3Aopen+repo:pytorch/pytorch+in%3Atitle+DISABLED&" \
             "&per_page=100"
    header, info = request_for_labels(prefix + "&page=1")
    issues_json: Dict[Any, Any] = {
        "items": [],
        "total_count": 0,
    }
    update_issues(issues_json, info)
    last_page = get_last_page(header)
    assert last_page > 0, "Error reading header info to determine total number of pages of labels"
    for page_number in range(2, last_page + 1):  # skip page 1
        _, info = request_for_labels(prefix + f"&page={page_number}")
        update_issues(issues_json, info)

    return issues_json


def validate_and_sort(issues_json: Dict[str, Any]) -> None:
    assert issues_json["total_count"] is len(issues_json["items"]), f"# issues {len(issues_json['items'])} does not" \
         f"equal total count {issues_json['total_count']}."
    assert not issues_json["incomplete_results"], f"Results were incomplete. There may be missing issues."
    issues_json["items"].sort(key=lambda x: x["url"])


def write_issues_to_file(issues_json: Dict[Any, Any]) -> None:
    with open("disabled-tests.json", mode="w") as file:
        json.dump(issues_json, file, sort_keys=True, indent=2)


def main() -> None:
    disable_issues = get_disable_issues()
    validate_and_sort(disable_issues)
    write_issues_to_file(disable_issues)


if __name__ == "__main__":
    main()
