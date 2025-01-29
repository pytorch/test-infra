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
from tqdm import tqdm  # type: ignore[import]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Queue alert for torchci")
    parser.add_argument("--query", type=str, help="Query name", required=True)
    parser.add_argument(
        "--head",
        type=str,
        help="Sha for the query to compare or get evaluations for",
        required=True,
    )
    parser.add_argument("--base", type=str, help="Base sha for comparison")
    parser.add_argument(
        "--perf", action="store_true", help="Run performance analysis/comparison"
    )
    parser.add_argument(
        "--results",
        action="store_true",
        help="Run results comparison.  Requires --base",
    )
    parser.add_argument(
        "--times",
        type=int,
        help="Number of times to run the query. Only relevant if --perf is used",
        default=10,
    )
    parser.add_argument(
        "--strict-results",
        action="store_true",
        help="Only relevant if --results is used. If set, it will sort the query results before comparing",
    )
    args = parser.parse_args()
    return args


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


def get_query_ids(query: str, params: dict, times: int) -> list[str]:
    def _get_query_id(query: str, params: dict) -> Optional[str]:
        try:
            res = get_clickhouse_client().query(query, params)
            return res.query_id
        except Exception as e:
            print(f"Error: {e}")
            return None

    return [
        x for _ in tqdm(range(times)) if (x := _get_query_id(query, params)) is not None
    ]


@cache
def get_query(query: str, sha: str) -> tuple:
    def _get_file(file_path: str) -> str:
        return subprocess.check_output(["git", "show", f"{sha}:{file_path}"]).decode(
            "utf-8"
        )

    tests = json.loads(_get_file(f"torchci/clickhouse_queries/{query}/params.json"))[
        "tests"
    ]
    query = _get_file(f"torchci/clickhouse_queries/{query}/query.sql")
    for test in tests:
        for key, value in test.items():
            if isinstance(value, dict):
                # special syntax for time values
                test[key] = (
                    datetime.now(timezone.utc) + timedelta(days=value["from_now"])
                ).strftime("%Y-%m-%d %H:%M:%S")
    return query, tests


def perf_compare(args: argparse.Namespace) -> None:
    query, tests = get_query(args.query, args.head)

    print(
        f"Gathering perf stats for: {args.query}\nNum tests: {len(tests)}\nNum times: {args.times}"
    )

    query_ids = []
    for i, test in enumerate(tests):
        new = get_query_ids(query, test, args.times)

        base = None
        if args.base:
            base_query, _ = get_query(args.query, args.base)
            base = get_query_ids(base_query, test, args.times)
        query_ids.append((new, base))

    # Split up the query execution and the stats collection because the stats
    # table needs time to populate. Also sleep for 10 seconds to the table more
    # time to populate
    time.sleep(20)
    table = PrettyTable()
    if args.base:
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
    if not args.base:
        print("Base sha is required for results comparison")
        return
    query, tests = get_query(args.query, args.head)
    base_query, _ = get_query(args.query, args.base)
    print(
        f"Comparing results for query: {args.query}\nNum tests: {len(tests)}\nHead: {args.head} Base: {args.base}"
    )
    for i, test in enumerate(tests):
        new_results = query_clickhouse(query, test)
        base_results = query_clickhouse(base_query, test)
        if args.strict_results:
            new_results = sorted(
                new_results, key=lambda x: json.dumps(x, sort_keys=True)
            )
            base_results = sorted(
                base_results, key=lambda x: json.dumps(x, sort_keys=True)
            )
        if new_results != base_results:
            print(f"Results for test {i} differ")
            print(f"Test: {json.dumps(test, indent=2)}")
            print(f"New: {new_results}")
            print(f"Base: {base_results}")
            print()
        else:
            print(f"Results for test {i} match")


if __name__ == "__main__":
    args = parse_args()
    if not args.perf and not args.results:
        print("Please specify --perf or --results")
        exit(1)
    if args.perf:
        perf_compare(args)
    if args.results:
        results_compare(args)
