import json
import math
import os
from collections import defaultdict

from typing import Any, List

import pandas as pd
from rockset import RocksetClient
from sklearn.metrics.pairwise import pairwise_distances


ROCKSET_API_KEY = os.environ.get("ROCKSET_API_KEY")
if ROCKSET_API_KEY is None:
    raise RuntimeError("ROCKSET_API_KEY not set")


def parse_args() -> Any:
    from argparse import ArgumentParser

    parser = ArgumentParser("Compute the correlation matrix across all CI jobs")
    parser.add_argument(
        "--ignore-flaky", action="store_true", help="ignore flaky results"
    )
    return parser.parse_args()


def ignore_flaky(df: pd.DataFrame) -> pd.DataFrame:
    # A flaky failure is consider as G(1) R(0) G(1)
    def _is_flaky(window: List[int]) -> bool:
        return window[0] == 1 and window[1] == 0 and window[2] == 1

    # Each column captures a CI job, and rows are commits sorted by time.
    return (
        df.rolling(window=3, center=True)
        .apply(lambda x: 1 if _is_flaky(x) else x[1])
        .fillna(0)
    )


def compute():
    args = parse_args()

    with open("rockset/prodVersions.json") as f:
        prod_versions = json.load(f)

    client = RocksetClient(
        api_key=ROCKSET_API_KEY,
        host="https://api.usw2a1.rockset.com",
    )
    response = client.QueryLambdas.execute_query_lambda(
        query_lambda="correlation_matrix",
        version=prod_versions["metrics"]["correlation_matrix"],
        workspace="metrics",
        parameters=[
            {
                "name": "workflowNames",
                "type": "string",
                "value": "pull,trunk,periodic,windows-binary-libtorch-debug,windows-binary-libtorch-release"
            },
        ],
    )

    pivot = defaultdict(dict)
    # Results look like (is_green, head_sha, name)
    # Turn results into a nested dict of head_sha => name => is_green
    for result in response.results:
        # skip pending jobs
        if result["is_green"] is None:
            continue

        head_sha = result["head_sha"]
        if head_sha not in pivot:
            pivot[head_sha] = {}

        name = result["name"]

        name = name.split("/", 1)[1].strip()
        if name not in pivot[head_sha]:
            pivot[head_sha][name] = 1

        pivot[head_sha][name] *= result["is_green"]

    pd.options.display.max_columns = None
    pd.options.display.max_rows = None
    pd.options.display.width = 0

    df = pd.DataFrame(pivot).transpose().fillna(0)
    if args.ignore_flaky:
        # Ignore flaky results
        df = ignore_flaky(df)

    # TLDR; Use hamming distance to calculate the similarity between jobs instead
    # of the default peason correlation provided by pandas df.corr()
    #
    # We should not use the default pearson correlation for categorical values here
    # because the result makes little sense. As an example, I gather MacOS data for
    # x86-64 and arm64 functorch as an example. They rarely fail except flaky, and
    # the two data series are mostly 1. I expect to see a value indicating a high
    # correlation between the twos, but the calculation returns 0 no correlation.
    # Correlation metrics for continuous data measure how the change (increase or
    # decrease) in one correlates with the other. Here there are just 0 and 1.
    correlation_matrix = pd.DataFrame(
        1 - pairwise_distances(df.transpose(), metric="hamming"),
        index=df.columns,
        columns=df.columns,
    )

    # Prepare for rendering in json:
    # Turn the nested dict of name => name => corr to Array<xAxis, yAxis, corr>
    correlation_matrix = correlation_matrix.to_dict()
    print(correlation_matrix["libtorch-cpu-shared-with-deps-debug-test"]["win-vs2019-cpu-py3 / test (default)"])
    print(correlation_matrix["libtorch-cpu-shared-with-deps-release-test"]["win-vs2019-cpu-py3 / test (default)"])
    data = []

    for xIdx, xName in enumerate(correlation_matrix):
        for yIdx, yName in enumerate(correlation_matrix[xName]):
            value = correlation_matrix[xName][yName]
            # nans mean we couldn't find any examples with both jobs populated.
            if math.isnan(value):
                continue

            data.append((xIdx, yIdx, value))

    with open("lib/correlation_matrix.json", "w") as f:
        json.dump({"names": list(correlation_matrix.keys()), "data": data}, f, indent=4)


if __name__ == "__main__":
    compute()
