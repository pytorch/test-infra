import json
from collections import defaultdict

import requests
from torchci.clickhouse import query_clickhouse_saved  # type: ignore[import-not-found]


TEST_TIMES_URL = "https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/test-times.json"
TEST_CLASS_TIMES_URL = "https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/test-class-times.json"

TEST_TIME_PER_FILE_QUERY_NAME = "test_time_per_file"
TEST_TIME_PER_FILE_PERIODIC_JOBS_QUERY_NAME = "test_time_per_file_periodic_jobs"
TEST_TIME_PER_CLASS_QUERY_NAME = "test_time_per_class"
TEST_TIME_PER_CLASS_PERIODIC_JOBS_QUERY_NAME = "test_time_per_class_periodic_jobs"


def get_file_data_from_db():
    return get_data_from_db(file_mode=True)


def get_class_data_from_db():
    return get_data_from_db(file_mode=False)


def get_data_from_db(file_mode: bool):
    general_query_name = (
        TEST_TIME_PER_FILE_QUERY_NAME if file_mode else TEST_TIME_PER_CLASS_QUERY_NAME
    )
    periodic_query_name = (
        TEST_TIME_PER_FILE_PERIODIC_JOBS_QUERY_NAME
        if file_mode
        else TEST_TIME_PER_CLASS_PERIODIC_JOBS_QUERY_NAME
    )

    db_result = query_clickhouse_saved(general_query_name, {})
    periodic_db_result = query_clickhouse_saved(periodic_query_name, {})
    return db_result + periodic_db_result


def download_old_test_file_times():
    return download_json(TEST_TIMES_URL)


def download_old_test_class_times():
    return download_json(TEST_CLASS_TIMES_URL)


def download_json(url):
    req = requests.get(url=url)
    if req.status_code == 404:
        print(f"Did not find any test times at {url}")
        return {}
    req.raise_for_status()
    return json.loads(req.text)


def convert_test_file_times_to_default_dict(d):
    new_d = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    for env in d:
        for config in d[env]:
            for file in d[env][config]:
                new_d[env][config][file] = d[env][config][file]
    return new_d


def convert_test_class_times_to_default_dict(d):
    new_d = defaultdict(
        lambda: defaultdict(lambda: defaultdict((lambda: defaultdict(float))))
    )
    for env in d:
        for config in d[env]:
            for file in d[env][config]:
                for testclass in d[env][config][file]:
                    new_d[env][config][file][testclass] = d[env][config][file][
                        testclass
                    ]
    return new_d


def gen_test_file_times(db_results, old_test_times):
    # Use old test times because sometimes we want to manually edit the test
    # times json and want those changes to persist.  Unfortunately this means
    # that the test times json grows and never shrinks, but we can edit the json
    # to make it smaller.  Defaults are always overriden.
    test_times = convert_test_file_times_to_default_dict(old_test_times)
    test_times_no_build_env = defaultdict(lambda: defaultdict(list))
    test_times_no_test_config = defaultdict(list)
    for row in db_results:
        test_times[row["base_name"]][row["test_config"]][row["file"]] = row["time"]
        test_times_no_build_env[row["test_config"]][row["file"]].append(row["time"])
        test_times_no_test_config[row["file"]].append(row["time"])

    # Add defaults
    for config in test_times_no_build_env:
        for test, times in test_times_no_build_env[config].items():
            test_times_no_build_env[config][test] = sum(times) / len(times)
    for test, times in test_times_no_test_config.items():
        test_times_no_test_config[test] = sum(times) / len(times)

    # Avoid overwriting the default if the new default is empty
    if test_times_no_build_env:
        # Default should never be a build env
        test_times["default"] = test_times_no_build_env

    # Avoid overwriting the default if the new default is empty
    if test_times_no_test_config:
        # Replace default's default with our own to account for tests that aren't
        # usually in the default test config like distributed
        test_times["default"]["default"] = test_times_no_test_config

    return test_times


def gen_test_class_times(db_results, old_test_times):
    # Use old test times because sometimes we want to manually edit the test
    # times json and want those changes to persist.  Unfortunately this means
    # that the test times json grows and never shrinks, but we can edit the json
    # to make it smaller.  Defaults are always overriden.
    test_times = convert_test_class_times_to_default_dict(old_test_times)

    test_times_no_build_env = defaultdict(
        lambda: defaultdict(lambda: defaultdict(list))
    )
    test_times_no_test_config = defaultdict(lambda: defaultdict(list))
    for row in db_results:
        test_times[row["base_name"]][row["test_config"]][row["file"]][
            row["classname"]
        ] = row["time"]
        test_times_no_build_env[row["test_config"]][row["file"]][
            row["classname"]
        ].append(row["time"])
        test_times_no_test_config[row["file"]][row["classname"]].append(row["time"])

    # Add defaults
    for config in test_times_no_build_env:
        for file in test_times_no_build_env[config]:
            for testclass, times in test_times_no_build_env[config][file].items():
                test_times_no_build_env[config][file][testclass] = sum(times) / len(
                    times
                )
    for file in test_times_no_test_config:
        for testclass, times in test_times_no_test_config[file].items():
            test_times_no_test_config[file][testclass] = sum(times) / len(times)

    # Avoid overwriting the default if the new default is empty
    if test_times_no_build_env:
        # Default should never be a build env
        test_times["default"] = test_times_no_build_env

    # Avoid overwriting the default if the new default is empty
    if test_times_no_test_config:
        # Replace default's default with our own to account for tests that aren't
        # usually in the default test config like distributed
        test_times["default"]["default"] = test_times_no_test_config

    return test_times


def main() -> None:
    test_file_times = gen_test_file_times(
        get_file_data_from_db(), download_old_test_file_times()
    )

    with open("test-times.json", "w") as f:
        f.write(json.dumps(test_file_times, indent=2, sort_keys=True))

    test_class_times = gen_test_class_times(
        get_class_data_from_db(), download_old_test_class_times()
    )

    with open("test-class-times.json", "w") as f:
        f.write(json.dumps(test_class_times, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
