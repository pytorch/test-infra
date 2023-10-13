import json
from collections import defaultdict
from typing import Dict

from utils_td_heuristics import (
    cache_json,
    evaluate,
    get_all_invoking_files,
    get_filtered_failed_tests,
    get_merge_bases_dict,
    list_past_year_shas,
    query_rockset,
)

CHANGED_FILES_QUERY = """
select
    sha,
    changed_files
from
    commons.merge_bases
where
    ARRAY_CONTAINS(SPLIT(:shas, ','), sha)
"""


@cache_json
def gen_correlation_dict() -> Dict[str, Dict[str, float]]:
    shas = list_past_year_shas()

    interval = 500
    commits = []
    for i in range(0, len(shas), interval):
        commits.extend(
            query_rockset(
                CHANGED_FILES_QUERY,
                params={"shas": ",".join(shas[i : i + interval])},
                use_cache=True,
            )
        )

    invoking_files = get_all_invoking_files()

    d = defaultdict(lambda: defaultdict(float))
    for commit in commits:
        changed_files = commit["changed_files"]
        test_files = [x[5:-3] for x in changed_files if x[5:-3] in invoking_files]
        for test_file in test_files:
            for file in changed_files:
                d[file][test_file] += 1 / len(changed_files)
    return d


if __name__ == "__main__":
    correlation_dict = gen_correlation_dict()
    merge_bases = get_merge_bases_dict()
    filtered_tests = get_filtered_failed_tests()

    evaluate(filtered_tests, merge_bases, correlation_dict)

    with open("td_heuristic_historical_edited_files.json", mode="w") as file:
        json.dump(correlation_dict, file, sort_keys=True, indent=2)
