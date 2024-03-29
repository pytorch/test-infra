import copy
import json
import os
from collections import defaultdict
from functools import cmp_to_key
from pathlib import Path

import matplotlib.pyplot as plt

from torchci.rockset_utils import query_rockset

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
OUTPUT_FOLDER = REPO_ROOT / "_logs" / "td_analysis"

QUERY = """
 SELECT
    m.test_name,
    m.num_heuristics_prioritized_by,
    ROUND(
        (
            m.aggregated.order_overall * 100.0 / m.num_total_tests
        )
    ) as order_percent,
    CUME_DIST() OVER(
        ORDER BY
            ROUND(
                (
                    m.aggregated.order_overall * 100.0 / m.num_total_tests
                )
            )
    ) as percent_rnk,
    m.aggregated.order_overall,
    m.aggregated.relevance_group,
    m.highest_ranking_heuristic,
    -- h.*,
    m.heuristics,
    m.aggregated,
    m.num_total_tests,
    m.run_attempt,
    m.run_number,
    m.run_id,
    m.workflow,
    m.job,
    m.build_environment,
    m.test_config,
FROM
    metrics.metrics m -- CROSS JOIN UNNEST (heuristics) h
where
    m.metric_name = 'td_test_failure_stats' -- and m.num_heuristics_prioritized_by > 0
    and m.test_name not like '%cpp%'
    and m.timestamp > PARSE_DATETIME_ISO8601('2023-09-16T00:00:00.0') -- metric fixes were made after this day
    -- and m.num_total_tests > 39 -- and m.highest_ranking_heuristic = 'EditedByPR'
    and not (
        m.highest_ranking_heuristic = 'PreviouslyFailedInPR'
        and m.aggregated.relevance_group = 'PROBABLE'
    )
order by
    m.timestamp desc

    """


def avg(l):
    if len(l) == 0:
        return 0
    return sum(l) / len(l)


def json_print(o):
    print(json.dumps(o, indent=2))


def make_csv(d, filename):
    import csv

    with open(filename, "w") as csvfile:
        writer = csv.DictWriter(csvfile, d[0].keys())
        writer.writeheader()
        writer.writerows(d)


def to_array(d, key_name):
    # Takes a dictionary and converts it to an array, good for converting to csv
    r = []
    for k, v in d.items():
        r.append({key_name: k, **v})
    return r


def get_heuristics_eval(data):
    # Basic heuristic evaluation including # of files before the failing test, %
    # times the file was ranked positively, % times it was the best, % of tests
    # the heuristic ranked each time (might not be super accurate if the
    # heuristic uses multiple relevance groups)
    heuristics_eval = defaultdict(
        lambda: {
            "count": 0,
            "count_ranked": 0,
            "num_files_before_list_when_ranked": [],
            "count_times_best": 0,
            "per_tests_ranked_list": [],
        }
    )

    def _compare_heueristics(h1, h2):
        ranking = ["NONE", "UNLIKELY", "UNRANKED", "PROBABLE", "HIGH"]
        if (
            x := ranking.index(h1["relevance_group"])
            - ranking.index(h2["relevance_group"])
        ) != 0:
            return x
        return h2["order_within_relevance_group"] - h1["order_within_relevance_group"]

    for r in data:
        best_heuristic = sorted(
            r["heuristics"], key=cmp_to_key(_compare_heueristics), reverse=True
        )[0]
        if best_heuristic["relevance_group"] in ("HIGH", "PROBABLE"):
            heuristics_eval[best_heuristic["heuristic_name"]]["count_times_best"] += 1

        for h in r["heuristics"]:
            name = h["heuristic_name"]
            heuristics_eval[name]["count"] += 1
            if h["relevance_group"] in ("HIGH", "PROBABLE"):
                heuristics_eval[name]["count_ranked"] += 1
                heuristics_eval[name]["num_files_before_list_when_ranked"].append(
                    h["order_overall"]
                )

            heuristics_eval[name]["num_files_before_list_when_ranked"].append(
                h["order_overall"]
            )
            heuristics_eval[name]["per_tests_ranked_list"].append(
                h["num_tests_in_relevance_group"] / r["num_total_tests"]
            )

    for v in heuristics_eval.values():
        count = v["count"]

        v["num_files_before_when_ranked"] = avg(v["num_files_before_list_when_ranked"])
        del v["num_files_before_list_when_ranked"]

        v["per_ranked"] = v["count_ranked"] / count
        del v["count_ranked"]

        v["per_times_best"] = v["count_times_best"] / count
        del v["count_times_best"]

        v["per_tests_ranked"] = avg(v["per_tests_ranked_list"])
        del v["per_tests_ranked_list"]

    return heuristics_eval


def get_heuristics_eval_without_PreviouslyFailedInPR(data):
    # Same as get_heuristics_eval, but without PreviouslyFailedInPR, since it is
    # the best ~40% of the time.
    new_data = []
    for r in data:
        new_r = copy.deepcopy(r)
        new_r["heuristics"] = [
            x
            for x in new_r["heuristics"]
            if x["heuristic_name"] != "PreviouslyFailedInPR"
        ]
        new_data.append(new_r)
    return get_heuristics_eval(new_data)


def get_heuristics_percentiles_charts(data):
    # Generates images of percentile info for the % of tests before the failing
    # test for each heuristic
    percentiles_info = defaultdict(list)
    for r in data:
        for h in r["heuristics"]:
            name = h["heuristic_name"]
            if h["relevance_group"] != "UNRANKED":
                percentiles_info[name].append(h["order_overall"] / r["num_total_tests"])
            percentiles_info["total"].append(r["order_overall"] / r["num_total_tests"])

    for heuristic_name, positions in percentiles_info.items():
        plt.plot(
            [(x + 1) / len(positions) for x in range(0, len(positions))],
            sorted(positions),
        )
        plt.savefig(OUTPUT_FOLDER / f"percentile_heuristic_{heuristic_name}.png")
        plt.clf()


def get_num_heuristics_prioritized_by(data):
    num_heuristics_prioritized_by = []
    for r in data:
        num_heuristics_prioritized_by.append(r["num_heuristics_prioritized_by"])

    plt.plot(
        [
            (x + 1) / len(num_heuristics_prioritized_by)
            for x in range(0, len(num_heuristics_prioritized_by))
        ],
        sorted(num_heuristics_prioritized_by),
    )
    plt.hlines(
        y=avg(num_heuristics_prioritized_by),
        xmin=0,
        xmax=1,
        linestyles="--",
        label="average",
    )
    plt.legend()
    plt.savefig(OUTPUT_FOLDER / f"percentile_num_heuristics_prioritized.png")
    plt.clf()


if __name__ == "__main__":
    os.makedirs(OUTPUT_FOLDER, exist_ok=True)
    rockset_data = query_rockset(QUERY, use_cache=True)

    make_csv(
        to_array(get_heuristics_eval(rockset_data), "heuristic"),
        OUTPUT_FOLDER / "heuristics_eval.csv",
    )
    make_csv(
        to_array(
            get_heuristics_eval_without_PreviouslyFailedInPR(rockset_data), "heuristic"
        ),
        OUTPUT_FOLDER / "heuristics_eval_without_PreviouslyFailedInPR.csv",
    )
    get_heuristics_percentiles_charts(rockset_data)
    get_num_heuristics_prioritized_by(rockset_data)
