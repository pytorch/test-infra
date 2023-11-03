import json
from collections import defaultdict
from pathlib import Path

from rockset_utils import query_rockset

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

FAILED_TESTS_QUERY = """
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

# See get_merge_base_info for structure, should have sha, merge_base, and
# changed_files fields
MERGE_BASES_QUERY = """
select
    merge_base,
    sha,
    changed_files
from merge_bases
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


def evaluate(failing_tests, merge_bases, rev_mapping, get_test_name_fn):
    # This function doesn't produce output that is used but is meant to help
    # evaluate if the currently rating/calculation is good.

    # Probably not exhaustive but whatever
    all_failing_tests = {get_test_name_fn(test) for test in failing_tests}

    scores = []
    for test in failing_tests:
        changed_files = merge_bases[test["head_sha"]]["changed_files"]

        prediction = defaultdict(int)
        for file in changed_files:
            for test_file, score in rev_mapping[file].items():
                prediction[test_file] += score

        failing_tests_sorted_by_score = [
            x[0] for x in sorted(prediction.items(), key=lambda x: x[1], reverse=True)
        ]
        failing_test = get_test_name_fn(test)
        if failing_test in failing_tests_sorted_by_score:
            index = failing_tests_sorted_by_score.index(failing_test)
            scores.append((index + 1) / len(all_failing_tests))
        else:
            scores.append(1)

    print(f"average: {sum(scores) / len(scores)}")
    print(f"median: {sorted(scores)[len(scores) // 2]}")
    print(f"within 10%: {(len([x for x in scores if x < .1]))/len(scores)}")
    print(f"# of failing tests: {len(all_failing_tests)}")
    print()


def extract_test_file_name(test_row):
    return f"{test_row['invoking_file']}"


def extract_test_class_name(test_row):
    if test_row["classname"]:
        return f"{test_row['invoking_file']}::{test_row['classname']}"
    else:
        return f"{test_row['invoking_file']}"


def calculate_test_file_ratings(tests, merge_bases):
    # Should return a mapping of changed file -> failing test files -> confidence score

    return calculate_generic_test_ratings(
        tests, merge_bases, get_test_name_fn=extract_test_file_name
    )


def calculate_test_class_ratings(tests, merge_bases):
    # Should return a mapping of changed file -> failing test classes -> confidence score

    return calculate_generic_test_ratings(
        tests, merge_bases, get_test_name_fn=extract_test_class_name
    )


def calculate_generic_test_ratings(tests, merge_bases, get_test_name_fn):
    # Should return a mapping of changed file -> correlated test failures -> confidence score

    # Get a mapping of failing test -> list of shas that broke it
    failing_tests_to_sha = defaultdict(set)
    for test in tests:
        failing_test = get_test_name_fn(test)
        sha = test["head_sha"]
        failing_tests_to_sha[failing_test].add(sha)

    # Make mapping of failing test -> changed file -> confidence score
    failing_tests_to_causes = {}
    for failing_test in failing_tests_to_sha:
        score_dict = defaultdict(int)  # changed file -> confidence score
        for sha in failing_tests_to_sha[failing_test]:
            changed_files = merge_bases[sha]["changed_files"]
            for changed_file in changed_files:
                score_dict[changed_file] += 1 / len(changed_files)
        failing_tests_to_causes[failing_test] = score_dict

    # Reverse the mapping to changed file -> failing test -> confidence score
    rev_mapping = defaultdict(lambda: defaultdict(float))
    for failing_test in failing_tests_to_causes:
        for changed_file in failing_tests_to_causes[failing_test]:
            rev_mapping[changed_file][failing_test] = failing_tests_to_causes[
                failing_test
            ][changed_file]
    return rev_mapping


def main() -> None:
    failed_tests = query_rockset(FAILED_TESTS_QUERY)
    merge_bases = query_rockset(MERGE_BASES_QUERY)
    print("done querying rockset", flush=True)

    merge_bases = {s["sha"]: s for s in merge_bases}
    filtered_tests = filter_tests(failed_tests, merge_bases)

    test_file_ratings = calculate_test_file_ratings(filtered_tests, merge_bases)
    test_class_ratings = calculate_test_class_ratings(filtered_tests, merge_bases)

    print("Evaluating test files:")
    evaluate(filtered_tests, merge_bases, test_file_ratings, extract_test_file_name)

    print("Evaluating test classes:")
    evaluate(filtered_tests, merge_bases, test_class_ratings, extract_test_class_name)

    with open("file_test_rating.json", mode="w") as file:
        json.dump(test_file_ratings, file, sort_keys=True, indent=2)

    with open("file_test_class_rating.json", mode="w") as file:
        json.dump(test_class_ratings, file, sort_keys=True, indent=2)


if __name__ == "__main__":
    main()
