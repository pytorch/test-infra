from collections import defaultdict
import json
from typing import List, Dict, Any

import requests
from torchci.rockset_utils import remove_from_rockset
from torchci.td.utils import (
    avg,
    med,
    get_all_invoking_files,
    get_filtered_failed_tests,
    get_merge_bases_dict,
)
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent


def get_imports_dict():
    # The dict should be generated elsewhere and this function modified to
    # retrieve the data.
    with open(REPO_ROOT / "_logs" / "mapping.json") as f:
        a = json.load(f)
    b = defaultdict(lambda: defaultdict(float))
    for tf, cfs in a.items():
        for cf in cfs:
            b[cf][tf] = 1
    return b
    url = "https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/td_heuristic_profiling.json"
    return json.loads(requests.get(url).text)


def main() -> None:
    readable_merge_bases_dict()

    merge_baess = get_merge_bases_dict()
    print(len(list(v for v in merge_baess.values() if len(v["changed_files"]) < 100)))
    with open(REPO_ROOT / "_logs" / "important_files.txt") as f:
        a = json.load(f)
    with open(REPO_ROOT / "_logs" / "all_files.txt") as f:
        b = json.load(f)

    count_a = 0
    count_b = 0
    out_of = 0
    for c, data in merge_baess.items():
        torch_files = [
            x
            for x in data["changed_files"]
            if x.startswith("torch/") and x.endswith(".py")
        ]
        if torch_files:
            out_of += 1
        if any(file in a for file in torch_files):
            count_a += 1
        if any(file in b for file in torch_files):
            count_b += 1
        # elif torch_files:
        #     print(data['changed_files'])

    print(count_a / out_of)
    print(count_b / out_of)

    import csv

    mydict = []
    with open(REPO_ROOT / "_logs" / "results.csv") as f:
        file = csv.DictReader(f)
        mydict.extend(row for row in file)

    # Count the number of tests that have fewer than 100 changed files
    print(
        len(
            [
                v
                for v in mydict
                if len(merge_baess[v["head_sha"]]["changed_files"]) < 100
            ]
        )
    )

    s = sorted(
        [
            int(test["position"])
            for test in mydict
            if test["position"] is not None and test["position"] != ""
        ]
    )
    print(f"avg: {avg(s)}")
    print(f"med: {med(s)}")
    print(f"per evaled: {len(s) / len(mydict)}")
    print(len(get_all_invoking_files()))
    import matplotlib.pyplot as plt

    plt.plot([(x + 1) / len(s) for x in range(0, len(s))], s)  # Plot the chart
    plt.show()  # display
    exit(0)

    # profiling_dict = get_imports_dict()
    # merge_bases = get_merge_bases_dict()
    # filtered_tests = get_filtered_failed_tests()

    # evaluate(filtered_tests, merge_bases, profiling_dict)

    # readable_merge_bases_dict()


def readable_merge_bases_dict():
    merge_bases_dict = get_merge_bases_dict()
    smaller = {k: m["changed_files"] for k, m in merge_bases_dict.items()}
    with open(REPO_ROOT / "_logs" / "readable_merge_bases.json", "w") as f:
        f.write(json.dumps(smaller, indent=2))


def evaluate(
    tests: List[Dict[str, Any]],
    merge_bases: Dict[str, Dict[str, Any]],
    rev_mapping: Dict[str, Dict[str, float]],
) -> None:
    import csv

    # This function creates a file called results.csv which contains information
    # about ordering of tests.  It doesn't produce output that is used but is
    # meant to help evaluate if the currently rating/calculation is good.

    all_invoking_files = get_all_invoking_files()

    output = []
    for test in tests:
        changed_files = merge_bases[test["head_sha"]]["changed_files"]

        prediction = defaultdict(int)
        for file in changed_files:
            for test_file, score in rev_mapping.get(file, {}).items():
                prediction[test_file] += score

        invoking_file = test["invoking_file"]

        position = None
        if invoking_file in prediction.keys():
            position = (
                sorted(
                    prediction.keys(), key=lambda x: prediction[x], reverse=True
                ).index(invoking_file)
                + 1
            )
        elif len(prediction) != 0:
            position = len(all_invoking_files)

        output.append({**test, "position": position})

    with open(REPO_ROOT / "_logs" / "results.csv", "w") as csvfile:
        writer = csv.DictWriter(csvfile, output[0].keys())
        writer.writeheader()
        writer.writerows(output)


if __name__ == "__main__":
    main()
