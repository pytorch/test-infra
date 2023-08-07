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
select * from merge_bases
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


def evaluate(tests, merge_bases, rev_mapping):
    # This function doesn't produce output that is used but is meant to help
    # evaluate if the currently rating/calculation is good.

    # Probably not exhaustive but whatever
    all_invoking_files = {test["invoking_file"] for test in tests}

    scores = []
    for test in tests:
        changed_files = merge_bases[test["head_sha"]]["changed_files"]

        prediction = defaultdict(int)
        for file in changed_files:
            for test_file, score in rev_mapping[file].items():
                prediction[test_file] += score

        test_files_sorted_by_score = [
            x[0] for x in sorted(prediction.items(), key=lambda x: x[1], reverse=True)
        ]
        invoking_file = test["invoking_file"]
        if invoking_file in test_files_sorted_by_score:
            index = test_files_sorted_by_score.index(invoking_file)
            scores.append((index + 1) / len(all_invoking_files))
        else:
            scores.append(1)

    print(f"average: {sum(scores) / len(scores)}")
    print(f"median: {sorted(scores)[len(scores) // 2]}")
    print(f"within 10%: {(len([x for x in scores if x < .1]))/len(scores)}")
    print(f"# of invoking files: {len(all_invoking_files)}")


def calculate_ratings(tests, merge_bases):
    # Should return a mapping of file -> test/invoking file -> score

    # Get a mapping of invoking/test file -> list of shas that broke it
    invoking_file_to_shas = defaultdict(set)
    for test in tests:
        invoking_file = test["invoking_file"]
        sha = test["head_sha"]
        invoking_file_to_shas[invoking_file].add(sha)

    # Make mapping of invoking/test file -> file -> score
    file_rating = {}
    for test_file in invoking_file_to_shas:
        score_dict = defaultdict(int)
        for sha in invoking_file_to_shas[test_file]:
            changed_files = merge_bases[sha]["changed_files"]
            for file in changed_files:
                score_dict[file] += 1 / len(changed_files)
        file_rating[test_file] = score_dict

    # Reverse the mapping to file -> test/invoking file -> score
    rev_mapping = defaultdict(lambda: defaultdict(float))
    for test_file in file_rating:
        for file in file_rating[test_file]:
            rev_mapping[file][test_file] = file_rating[test_file][file]
    return rev_mapping


def main() -> None:
    failed_tests = query_rockset(FAILED_TESTS_QUERY)
    merge_bases = query_rockset(MERGE_BASES_QUERY)
    print("done querying rockset", flush=True)

    merge_bases = {s["sha"]: s for s in merge_bases}
    filtered_tests = filter_tests(failed_tests, merge_bases)

    ratings = calculate_ratings(filtered_tests, merge_bases)

    evaluate(filtered_tests, merge_bases, ratings)

    with open("file_test_rating.json", mode="w") as file:
        json.dump(ratings, file, sort_keys=True, indent=2)


if __name__ == "__main__":
    main()
