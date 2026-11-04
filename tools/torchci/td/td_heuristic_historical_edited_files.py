import json
import math
from collections import defaultdict
from typing import Dict, Iterable, List

from torchci.clickhouse import query_clickhouse
from torchci.td.utils import (
    cache_json,
    evaluate,
    get_all_invoking_files,
    get_filtered_failed_tests,
    get_merge_bases_dict,
    list_past_year_shas,
    positive_rounded,
)


# Pseudo-count added to each file's and each test file's commit count, so files
# and tests seen in only a few commits cannot reach a high PMI.
PMI_SMOOTHING = 5
# A pair seen together n times keeps n / (n + PMI_SHRINKAGE) of its PMI, which
# shrinks pairs that met once toward 0.
PMI_SHRINKAGE = 3


CHANGED_FILES_QUERY = """
select
    sha,
    changed_files
from
    default.merge_bases
where
    sha in {shas: Array(String)}
"""


@cache_json
def gen_correlation_dict() -> Dict[str, Dict[str, float]]:
    shas = list_past_year_shas()

    interval = 500
    commits = []
    for i in range(0, len(shas), interval):
        commits.extend(
            query_clickhouse(
                CHANGED_FILES_QUERY,
                params={"shas": shas[i : i + interval]},
                use_cache=True,
            )
        )

    invoking_files = set(get_all_invoking_files())

    commit_files = []
    for commit in commits:
        changed_files = commit["changed_files"]
        # Fullname of test files look like test/<file>.py, but invoking files
        # from the database don't include the test/ or the .py extension, so
        # remove those
        test_files = [x[5:-3] for x in changed_files if x[5:-3] in invoking_files]
        commit_files.append((changed_files, test_files))
    return positive_pmi(commit_files)


def positive_pmi(
    commit_files: Iterable[tuple[List[str], List[str]]],
) -> Dict[str, Dict[str, float]]:
    # Scores how much more often test file t is edited with file f than their
    # separate edit rates predict, over the commits that edit a test file, so
    # files edited with everything do not look linked to every test.
    num_commits = 0
    file_count: Dict[str, int] = defaultdict(int)
    test_count: Dict[str, int] = defaultdict(int)
    pair_count: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for changed_files, test_files in commit_files:
        if not test_files:
            continue
        num_commits += 1
        for test_file in set(test_files):
            test_count[test_file] += 1
        for file in set(changed_files):
            file_count[file] += 1
            for test_file in set(test_files):
                pair_count[file][test_file] += 1

    d: Dict[str, Dict[str, float]] = defaultdict(dict)
    for file, tests in pair_count.items():
        for test_file, n in tests.items():
            pmi = math.log(
                n
                * num_commits
                / (
                    (file_count[file] + PMI_SMOOTHING)
                    * (test_count[test_file] + PMI_SMOOTHING)
                )
            )
            if pmi > 0:
                d[file][test_file] = pmi * n / (n + PMI_SHRINKAGE)
    return d


if __name__ == "__main__":
    correlation_dict = gen_correlation_dict()
    merge_bases = get_merge_bases_dict()
    filtered_tests = get_filtered_failed_tests()

    evaluate(filtered_tests, merge_bases, correlation_dict)

    with open("td_heuristic_historical_edited_files.json", mode="w") as file:
        json.dump(positive_rounded(correlation_dict), file, sort_keys=True, indent=2)
