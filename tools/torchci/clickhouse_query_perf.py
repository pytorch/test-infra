"""
Check query results and performance. Note that query performance is not stable
and can vary significantly between runs.
"""

import argparse
import json
import subprocess
import time
from datetime import datetime, timedelta, timezone
from functools import cache
from typing import Optional

from prettytable import PrettyTable
from torchci.clickhouse import get_clickhouse_client, query_clickhouse
from torchci.utils import REPO_ROOT
from tqdm import tqdm


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Queue alert for torchci")
    parser.add_argument("--query", type=str, help="Query name", required=True)
    parser.add_argument(
        "--perf", action="store_true", help="Run performance comparison"
    )
    parser.add_argument("--results", action="store_true", help="Run results comparison")
    parser.add_argument(
        "--times",
        type=int,
        help="Number of times to run the query. Only relevant if --perf is used",
        default=10,
    )
    parser.add_argument(
        "--compare",
        type=str,
        help="Either a sha or a branch name to compare against. These should be available locally. Required for --results",
    )
    args = parser.parse_args()
    return args


def get_query_id(query: str, params: dict) -> Optional[str]:
    try:
        res = get_clickhouse_client().query(query, params)
        return res.query_id
    except Exception as e:
        print(f"Error: {e}")
        return None


@cache
def get_base_query(query: str, sha: str) -> str:
    return subprocess.check_output(
        ["git", "show", f"{sha}:torchci/clickhouse_queries/{query}/query.sql"]
    ).decode("utf-8")


EXECUTION_METRICS = """
SELECT
    round(avg(query_duration_ms)) AS realTimeMSAvg,
    avg(memory_usage) as memoryBytesAvg
FROM
    clusterAllReplicas(default, system.query_log)
where
    has({query_ids: Array(String)}, query_id)
    and type = 'QueryFinish'
"""


def get_avg_stats(query_ids: list) -> tuple:
    metrics = query_clickhouse(EXECUTION_METRICS, {"query_ids": query_ids})
    return metrics[0]["realTimeMSAvg"], metrics[0]["memoryBytesAvg"]


def get_query_ids(query: str, params: dict, times: int) -> tuple:
    return [
        x for _ in tqdm(range(times)) if (x := get_query_id(query, params)) is not None
    ]


def format_comparision_string(new: float, old: float) -> str:
    return f"{new} vs {old} ({new - old}, {round(100 * (new - old) / old)}%)"


@cache
def get_query(query: str) -> tuple:
    with open(
        REPO_ROOT / "torchci" / "clickhouse_queries" / query / "params.json"
    ) as f:
        tests = json.load(f).get("tests", [])
    with open(REPO_ROOT / "torchci" / "clickhouse_queries" / query / "query.sql") as f:
        query = f.read()
    for test in tests:
        for key, value in test.items():
            if isinstance(value, dict):
                # special syntax for time values
                test[key] = (
                    datetime.now(timezone.utc) + timedelta(days=value["from_now"])
                ).strftime("%Y-%m-%d %H:%M:%S")
    return query, tests


def perf_compare(args: argparse.Namespace) -> None:
    query, tests = get_query(args.query)

    print(
        f"Gathering perf stats for: {args.query}\nNum tests: {len(tests)}\nNum times: {args.times}"
    )

    query_ids = []
    for i, test in enumerate(tests):
        new = get_query_ids(query, test, args.times)

        base = None
        if args.compare:
            base_query = get_base_query(args.query, args.compare)
            base = get_query_ids(base_query, test, args.times)
        query_ids.append((new, base))

    # Split up the query execution and the stats collection because the stats
    # table needs time to populate. Also sleep for 10 seconds to the table more
    # time to populate
    time.sleep(20)
    table = PrettyTable()
    if args.compare:
        table.field_names = [
            "Test",
            "Avg Time",
            "Base Time",
            "Time Change",
            "% Time Change",
            "Avg Mem",
            "Base Mem",
            "Mem Change",
            "% Mem Change",
        ]
    else:
        table.field_names = ["Test", "Avg Time", "Avg Mem"]
    for i, (new, base) in enumerate(query_ids):
        avg_time, avg_bytes = get_avg_stats(new)
        if base:
            old_avg_time, old_avg_bytes = get_avg_stats(base)
            table.add_row(
                [
                    i,
                    avg_time,
                    old_avg_time,
                    avg_time - old_avg_time,
                    round(100 * (avg_time - old_avg_time) / old_avg_time),
                    avg_bytes,
                    old_avg_bytes,
                    avg_bytes - old_avg_bytes,
                    round(100 * (avg_bytes - old_avg_bytes) / old_avg_bytes),
                ]
            )
        else:
            table.add_row([i, avg_time, avg_bytes])
    print(table)


def results_compare(args: argparse.Namespace) -> None:
    query, tests = get_query(args.query)
    if not args.compare:
        return
    base_query = get_base_query(args.query, args.compare)
    print(
        f"Comparing results for query: {args.query}\nNum tests: {len(tests)}\nBase: {args.compare}"
    )
    for i, test in enumerate(tests):
        new_results = query_clickhouse(query, test)
        base_results = query_clickhouse(base_query, test)
        if new_results != base_results:
            print(f"Results for test {i} differ")
            print(f"Test: {json.dumps(test, indent=2)}")
            print(f"New: {new_results}")
            print(f"Base: {base_results}")
            print()


if __name__ == "__main__":
    args = parse_args()
    if args.perf:
        perf_compare(args)
    if args.results:
        results_compare(args)
