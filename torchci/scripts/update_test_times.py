from collections import defaultdict
import json
import requests
import rockset
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

PROD_VERSIONS_FILE = REPO_ROOT / "torchci" / "rockset" / "prodVersions.json"
TEST_TIMES_URL = "https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/test-times.json"


def get_data_from_rockset():
    rockset_client = rockset.RocksetClient(
        host="api.usw2a1.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    )
    with open(PROD_VERSIONS_FILE) as f:
        prod_versions = json.load(f)

    rockset_result = rockset_client.QueryLambdas.execute_query_lambda(
        query_lambda="test_time_per_file",
        version=prod_versions["commons"]["test_time_per_file"],
        workspace="commons",
    ).results
    periodic_rockset_result = rockset_client.QueryLambdas.execute_query_lambda(
        query_lambda="test_time_per_file_periodic_jobs",
        version=prod_versions["commons"]["test_time_per_file_periodic_jobs"],
        workspace="commons",
    ).results
    return rockset_result + periodic_rockset_result


def download_old_test_times():
    return json.loads(requests.get(url=TEST_TIMES_URL).text)


def convert_to_default_dict(d):
    new_d = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    for env in d:
        for config in d[env]:
            for file in d[env][config]:
                new_d[env][config][file] = d[env][config][file]
    return new_d


def gen_test_times(rockset_results, old_test_times):
    # Use old test times because sometimes we want to manually edit the test
    # times json and want those changes to persist.  Unfortunately this means
    # that the test times json grows and never shrinks, but we can edit the json
    # to make it smaller.  Defaults are always overriden.
    test_times = convert_to_default_dict(old_test_times)
    test_times_no_build_env = defaultdict(lambda: defaultdict(list))
    test_times_no_test_config = defaultdict(list)
    for row in rockset_results:
        test_times[row["base_name"]][row["test_config"]][row["file"]] = row["time"]
        test_times_no_build_env[row["test_config"]][row["file"]].append(row["time"])
        test_times_no_test_config[row["file"]].append(row["time"])

    # Add defaults
    for config in test_times_no_build_env:
        for test, times in test_times_no_build_env[config].items():
            test_times_no_build_env[config][test] = sum(times) / len(times)
    for test, times in test_times_no_test_config.items():
        test_times_no_test_config[test] = sum(times) / len(times)

    # Default should never be a build env
    test_times["default"] = test_times_no_build_env
    # Replace default's default with our own to account for tests that aren't
    # usually in the default test config like distributed
    test_times["default"]["default"] = test_times_no_test_config
    return test_times


def main() -> None:
    test_times = gen_test_times(get_data_from_rockset(), download_old_test_times())

    with open("test-times.json", "w") as f:
        f.write(json.dumps(test_times, indent=2, sort_keys=True))


if __name__ == "__main__":
    print(download_old_test_times())
    # main()
