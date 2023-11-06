import json

import requests

from utils_td_heuristics import (
    evaluate,
    get_filtered_failed_tests,
    get_merge_bases_dict,
)


def get_profiling_dict():
    # The dict should be generated elsewhere and this function modified to
    # retrieve the data.
    url = "https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/td_heuristic_profiling.json"
    return json.loads(requests.get(url).text)


def main() -> None:
    profiling_dict = get_profiling_dict()
    merge_bases = get_merge_bases_dict()
    filtered_tests = get_filtered_failed_tests()

    evaluate(filtered_tests, merge_bases, profiling_dict)

    with open("td_heuristic_profiling.json", mode="w") as file:
        json.dump(profiling_dict, file, sort_keys=True, indent=2)


if __name__ == "__main__":
    main()
