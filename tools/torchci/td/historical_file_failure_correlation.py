import json
from collections import defaultdict

from torchci.clickhouse import query_clickhouse
from torchci.td.utils import (
    calculate_generic_test_ratings,
    evaluate,
    get_merge_bases_dict,
)


FAILED_TESTS_QUERY = """
select
    w.head_sha,
    JSONExtractString(t.info, 'failure') as failure
from
    default.workflow_run w
    join misc.ossci_uploaded_metrics t on t.run_id = w.id
where
    t.metric_name = 'td_test_failure_stats_v2'
    and t.timestamp > CURRENT_TIMESTAMP() - interval 90 day
"""


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
            # Should only happen if the table is unfilled, or if the sha
            # doesn't exist somehow
            continue
        merge_base = merge_bases[sha]["merge_base"]
        present_on_merge_base = False
        for base_test in tests_by_sha.get(merge_base, []):
            if base_test["failure"] == test["failure"]:
                present_on_merge_base = True
                break
        if not present_on_merge_base:
            not_present_on_merge_base.append(test)
    return not_present_on_merge_base


def main() -> None:
    failed_tests = query_clickhouse(FAILED_TESTS_QUERY, {})
    merge_bases = get_merge_bases_dict()
    print("done querying", flush=True)

    filtered_tests = filter_tests(failed_tests, merge_bases)

    test_file_ratings = calculate_generic_test_ratings(
        filtered_tests, merge_bases, lambda x: x["failure"]
    )

    print("Evaluating test files:")
    evaluate(filtered_tests, merge_bases, test_file_ratings, lambda x: x["failure"])

    with open("file_test_rating.json", mode="w") as file:
        json.dump(test_file_ratings, file, sort_keys=True, indent=2)


if __name__ == "__main__":
    main()
