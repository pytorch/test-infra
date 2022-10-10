#!/usr/bin/env python3
"""
Query for the DISABLED test issues.

"""

import json
import os
from rockset import Client, ParamDict
from typing import Any, Dict, List

PLATFORMS = [
    "asan",
    "linux",
    "mac",
    "macos",
    "rocm",
    "win",
    "windows",
]


def get_skipped_issues_from_rockset() -> Any:
    params = ParamDict(
        {
            "label": "skipped",
        }
    )
    ROCKSET_API_KEY = os.environ.get("ROCKSET_API_KEY")
    if ROCKSET_API_KEY is None:
        raise RuntimeError("ROCKSET_API_KEY not set")

    with open("torchci/rockset/prodVersions.json") as f:
        prod_versions = json.load(f)

    client = Client(
        api_key=ROCKSET_API_KEY,
        api_server="https://api.rs2.usw2.rockset.com",
    )
    qlambda = client.QueryLambda.retrieve(
        "issue_query",
        version=prod_versions["commons"]["issue_query"],
        workspace="commons",
    )

    return qlambda.execute(parameters=params).results


def gen_disabled_tests_dict(issues: List[Dict[Any, Any]]) -> None:
    disabled_tests = {}
    for issue in issues:
        if not issue["title"].startswith("DISABLED "):
            continue
        test_name = issue["title"][len("DISABLED ") :].strip()
        platforms_to_skip = []
        for line in issue["body"].splitlines():
            line = line.lower()
            if line.startswith("platforms:"):
                platforms_to_skip.extend(
                    [
                        x.strip()
                        for x in line[len("platforms:") :].split(",")
                        if x.strip() and x.strip() in PLATFORMS
                    ]
                )
            disabled_tests[test_name] = (
                str(issue["number"]),
                issue["html_url"],
                platforms_to_skip,
            )
    return disabled_tests


def main() -> None:
    open_skipped_issues = list(
        filter(lambda x: x["state"] == "open", get_skipped_issues_from_rockset())
    )
    disabled_tests = gen_disabled_tests_dict(open_skipped_issues)
    with open("disabled-tests-condensed.json", mode="w") as file:
        json.dump(disabled_tests, file, sort_keys=True, indent=2)


if __name__ == "__main__":
    main()
