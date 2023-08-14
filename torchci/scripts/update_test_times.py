from collections import defaultdict
import json
import rockset
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

PROD_VERSIONS_FILE = REPO_ROOT / "torchci" / "rockset" / "prodVersions.json"


def main() -> None:
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

    test_times = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    test_times_no_build_env = defaultdict(lambda: defaultdict(list))
    test_times_no_test_config = defaultdict(list)
    for row in rockset_result + periodic_rockset_result:
        test_times[row["base_name"]][row["test_config"]][row["file"]] = row["time"]
        test_times_no_build_env[row["test_config"]][row["file"]].append(row["time"])
        test_times_no_test_config[row["file"]].append(row["time"])

    # Add defaults
    for config in test_times_no_build_env:
        for test, times in test_times_no_build_env[config].items():
            test_times_no_build_env[config][test] = sum(times) / len(times)
    for test, times in test_times_no_test_config.items():
        test_times_no_test_config[test] = sum(times) / len(times)

    if "default" not in test_times:
        test_times["default"] = test_times_no_build_env
    if "default" not in test_times["default"]:
        test_times["default"] = test_times_no_test_config

    with open("test-times.json", "w") as f:
        f.write(json.dumps(test_times, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
