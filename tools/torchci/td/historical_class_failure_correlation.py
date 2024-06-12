import json

from torchci.rockset_utils import query_rockset

from torchci.td.utils import (
    calculate_generic_test_ratings,
    evaluate,
    filter_tests,
    get_merge_bases_dict,
)

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
    and t._event_time > CURRENT_TIMESTAMP() - DAYS(90)
"""


def extract_test_class_name(test_row):
    if test_row["classname"]:
        return f"{test_row['invoking_file']}::{test_row['classname']}"
    else:
        return f"{test_row['invoking_file']}"


def main() -> None:
    failed_tests = query_rockset(FAILED_TESTS_QUERY)
    print("done querying rockset", flush=True)

    merge_bases = get_merge_bases_dict()
    filtered_tests = filter_tests(failed_tests, merge_bases)

    test_class_ratings = calculate_generic_test_ratings(
        filtered_tests, merge_bases, get_test_name_fn=extract_test_class_name
    )

    print("Evaluating test classes:")
    evaluate(filtered_tests, merge_bases, test_class_ratings, extract_test_class_name)

    with open("file_test_class_rating.json", mode="w") as file:
        json.dump(test_class_ratings, file, sort_keys=True, indent=2)


if __name__ == "__main__":
    main()
