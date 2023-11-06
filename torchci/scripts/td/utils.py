import csv
import json
from collections import defaultdict
from functools import lru_cache
from typing import Any, Dict, List

import requests

from torchci.scripts.rockset_utils import query_rockset
from torchci.scripts.utils import cache_json, run_command


def list_past_year_shas():
    return run_command(["git", "log", "--pretty=%H", "--since='1 year'"]).splitlines()


def download_test_times():
    return json.loads(
        requests.get(
            "https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/test-times.json"
        ).text
    )


@lru_cache
def get_all_invoking_files() -> List[str]:
    invoking_files = """
    select
        distinct invoking_file
    from
        commons.test_run_summary t
    """
    return [
        x["invoking_file"].replace(".", "/")
        for x in query_rockset(invoking_files, use_cache=True)
    ]


@cache_json
def filter_tests(failed_tests, merge_bases):
    # Remove tests that don't have a merge base or also fail on the merge base.

    tests_by_sha = defaultdict(list)
    for test in failed_tests:
        sha = test["head_sha"]
        tests_by_sha[sha].append(test)

    not_present_on_merge_base = []
    for test in failed_tests:
        sha = test["head_sha"]
        if sha not in merge_bases:
            # Should only happen if rockset table is unfilled, or if the sha
            # doesn't exist somehow
            continue
        merge_base = merge_bases[sha]["merge_base"]
        present_on_merge_base = False
        for base_test in tests_by_sha.get(merge_base, []):
            if (
                base_test["invoking_file"] == test["invoking_file"]
                and base_test["name"] == test["name"]
                and base_test["classname"] == test["classname"]
                and base_test["file"] == test["file"]
            ):
                present_on_merge_base = True
                break
        if not present_on_merge_base:
            not_present_on_merge_base.append(test)
    return not_present_on_merge_base


def avg(l: List[float]) -> str:
    if len(l) == 0:
        return "N/A"
    return f"{sum(l) / len(l):.2f}"


def med(l: List[float]) -> str:
    if len(l) == 0:
        return "N/A"
    return f"{sorted(l)[len(l) // 2]:.2f}"


def evaluate(
    tests: List[Dict[str, Any]],
    merge_bases: Dict[str, Dict[str, Any]],
    rev_mapping: Dict[str, Dict[str, float]],
) -> None:
    # This function creates a file called results.csv which contains information
    # about ordering of tests.  It doesn't produce output that is used but is
    # meant to help evaluate if the currently rating/calculation is good.

    all_invoking_files = get_all_invoking_files()

    scores = []
    score_per_file = defaultdict(list)
    for test in tests:
        changed_files = merge_bases[test["head_sha"]]["changed_files"]

        prediction = defaultdict(int)
        for file in changed_files:
            for test_file, score in rev_mapping.get(file, {}).items():
                prediction[test_file] += score

        test_files_sorted_by_score = [
            x[0] for x in sorted(prediction.items(), key=lambda x: x[1], reverse=True)
        ]
        invoking_file = test["invoking_file"]
        position = {}
        for i, file in enumerate(test_files_sorted_by_score):
            position[file] = (i + 1) / len(all_invoking_files)
        scores.append(position.get(invoking_file, 1))
        for file in all_invoking_files:
            score_per_file[file].append((position.get(file, 1), invoking_file == file))

    print(f"average: {avg(scores)}")
    print(f"median: {med(scores)}")
    print(f"within 10%: {(len([x for x in scores if x < .1]))/len(scores)}")
    print(f"# of invoking files: {len(all_invoking_files)}")

    res = []
    for file, raw_scores in score_per_file.items():
        scores = [x[0] for x in raw_scores]
        wrong_scores = [x[0] for x in raw_scores if not x[1]]
        right_scores = [x[0] for x in raw_scores if x[1]]
        res.append(
            {
                "file": file,
                "average": avg(scores),
                "median": med(scores),
                "average wrong": avg(wrong_scores),
                "median wrong": med(wrong_scores),
                "average right": avg(right_scores),
                "median right": med(right_scores),
                "count": len(right_scores),
            }
        )

    with open("results.csv", "w") as csvfile:
        writer = csv.DictWriter(csvfile, res[0].keys())
        writer.writeheader()
        writer.writerows(res)


@cache_json
def get_merge_bases_dict() -> Dict[str, Dict[str, Any]]:
    # Returns dictionary of commit sha -> dictionary with info about that
    # commit, including changes files and merge base
    merge_bases_query = """
    select * from merge_bases where repo is null or repo = 'pytorch/pytorch'
    """
    merge_bases_list = query_rockset(merge_bases_query)
    return {s["sha"]: s for s in merge_bases_list}


@cache_json
def get_filtered_failed_tests() -> List[Dict[str, Any]]:
    failed_tests_query = """
    SELECT
        distinct REPLACE(t.invoking_file, '.', '/') as invoking_file,
        t.name,
        t.classname,
        t.file,
        j.head_sha,
    FROM
        commons.failed_tests_run t
        join workflow_job j on t.job_id = j.id
    where
        t.file is not null
    """
    failed_tests = query_rockset(failed_tests_query, use_cache=True)
    return filter_tests(failed_tests, get_merge_bases_dict())
