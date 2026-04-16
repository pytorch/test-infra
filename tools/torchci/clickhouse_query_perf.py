#!/usr/bin/env python3
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
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from prettytable import PrettyTable
from torchci.clickhouse import get_clickhouse_client, query_clickhouse
from torchci.utils import REPO_ROOT
from tqdm import tqdm  # type: ignore[import]


def get_latest_commit() -> str:
    """Get the SHA of the latest commit."""
    return subprocess.check_output(["git", "rev-parse", "HEAD"]).decode("utf-8").strip()


def get_unstaged_file(file_path: str) -> str:
    """Get the contents of an unstaged file."""
    with open(file_path, "r", encoding="utf-8") as f:
        return f.read()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Queue alert for torchci")
    parser.add_argument("--query", type=str, help="Query name", required=True)
    parser.add_argument(
        "--head",
        type=str,
        help="Sha for the query to compare or get evaluations for. Default is unstaged changes.",
        required=False,
    )
    parser.add_argument(
        "--base",
        type=str,
        help="Base sha for comparison. Default is latest commit for --results and None for --perf",
    )
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
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print the first execution result of the query",
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
    quantile(0.5)(query_duration_ms) AS realTimeMSAvg,
    quantile(0.5)(memory_usage) as memoryBytesAvg,
    count() as cnt
FROM
    clusterAllReplicas(default, system.query_log)
where
    has({query_ids: Array(String)}, query_id)
    and type = 'QueryFinish'
    and event_time >= now() - interval 1 hour
"""


def get_avg_stats(query_ids: Optional[List[str]]) -> tuple:
    if not query_ids:
        return None, None
    i = 0
    while True:
        metrics = query_clickhouse(EXECUTION_METRICS, {"query_ids": query_ids})
        if int(metrics[0]["cnt"]) == len(query_ids):
            break
        if i == 1:
            print("Waiting for metrics to populate, please be patient")
        time.sleep(5)
        i += 1

    return metrics[0]["realTimeMSAvg"], metrics[0]["memoryBytesAvg"]


def get_query_ids(
    query: str, params: dict, times: int
) -> tuple[list[str], Optional[list]]:
    """
    Execute a query multiple times and collect query IDs and first result set.

    Args:
        query: SQL query string to execute
        params: Dictionary of query parameters
        times: Number of times to execute the query

    Returns:
        tuple: (list of query IDs, result data from first execution)
              Query IDs can be used to retrieve performance metrics later.
    """

    def _get_query_id(query: str, params: dict) -> tuple[Optional[str], Optional[list]]:
        try:
            res = get_clickhouse_client().query(
                query,
                params,
                settings={"enable_filesystem_cache": 0, "use_query_cache": 0},
            )
            return res.query_id, res.result_set
        except Exception as e:
            print(f"Error: {e}")
            return None, None

    result_data = None
    query_ids = []

    for i in tqdm(range(times)):
        first_run = i == 0
        query_id, data = _get_query_id(query, params)
        if query_id is not None:
            query_ids.append(query_id)
            if first_run:
                result_data = data

    return query_ids, result_data


@cache
def get_query(query: str, sha: str) -> tuple:
    def _get_file(file_path: str) -> str:
        if sha == "unstaged":
            # Use local filesystem for unstaged changes
            query_path = REPO_ROOT / file_path
            return get_unstaged_file(str(query_path))
        else:
            # Use git show for committed changes
            return subprocess.check_output(
                ["git", "show", f"{sha}:{file_path}"]
            ).decode("utf-8")

    query_path = f"torchci/clickhouse_queries/{query}/params.json"
    tests = json.loads(_get_file(query_path))["tests"]
    query_sql = _get_file(f"torchci/clickhouse_queries/{query}/query.sql")
    for test in tests:
        for key, value in test.items():
            if isinstance(value, dict):
                # special syntax for time values
                test[key] = (
                    datetime.now(timezone.utc) + timedelta(days=value["from_now"])
                ).strftime("%Y-%m-%d %H:%M:%S")
    return query_sql, tests


def verbose_print_results(
    results: Optional[List[Dict[str, Any]]], title: str = ""
) -> None:
    if not results:
        print(f"=== No results for {title} found")
        return
    print(f"\n=== {title} Results (first {min(5, len(results))} rows) ===")
    for i, row in enumerate(results[:5]):
        print(f"Row {i}: {json.dumps(row, indent=2)}")
    print(f"Total rows: {len(results)}")
    print("=" * 50)


def perf_compare(args: argparse.Namespace) -> None:
    query, tests = get_query(args.query, args.head)

    print(
        f"Gathering perf stats for: {args.query}\nNum tests: {len(tests)}\nNum times: {args.times}"
    )

    query_ids = []

    for i, test in enumerate(tests):
        new_qids, new_results = get_query_ids(query, test, args.times)

        if args.verbose:
            verbose_print_results(new_results, f"Test {i}")

        base_qids = None
        if args.base:
            base_query, _ = get_query(args.query, args.base)
            base_qids, base_results = get_query_ids(base_query, test, args.times)

            if args.verbose:
                verbose_print_results(base_results, f"Test {i} Base")

        query_ids.append((new_qids, base_qids))

    # Split up the query execution and the stats collection because the stats
    # table needs time to populate.
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
        if args.base:
            old_avg_time, old_avg_bytes = get_avg_stats(base)

            if avg_time is None or old_avg_time is None:
                table.add_row(
                    [
                        i,
                        avg_time,
                        old_avg_time,
                        None,
                        None,
                        avg_bytes,
                        old_avg_bytes,
                        None,
                        None,
                    ]
                )
                continue

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
    results_folder = REPO_ROOT / "_logs" / "query_results"
    if not results_folder.exists():
        results_folder.mkdir(parents=True)
    print(
        f"Comparing results for query: {args.query}\nNum tests: {len(tests)}\nHead: {args.head}\n Base: {args.base}"
    )
    for i, test in enumerate(tests):
        try:
            new_results = query_clickhouse(query, test)
        except Exception as e:
            print(f"New query for test {i} failed: {e}")
            print("Aborting comparison")
            raise e

        try:
            base_results = query_clickhouse(base_query, test)
            has_base_results = True
        except Exception as e:
            print(f"Base query for test {i} failed: {e}")
            base_results = []
            has_base_results = False

        if args.verbose:
            verbose_print_results(new_results, f"Test {i} New")

        if not has_base_results:
            print(f"Cannot compare results for test {i} - base query failed")
            with open(results_folder / f"{args.query}_{i}_new.json", "w") as f:
                json.dump(new_results, f, indent=2)
            print("New results can be found in the _logs/query_results folder")
            print()
            continue

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
            with open(results_folder / f"{args.query}_{i}_new.json", "w") as f:
                json.dump(new_results, f, indent=2)
            with open(results_folder / f"{args.query}_{i}_base.json", "w") as f:
                json.dump(base_results, f, indent=2)
            print("Results can be found in the _logs/query_results folder")
            print()
        else:
            print(f"Results ({len(new_results)} rows) for test {i} match")


if __name__ == "__main__":
    load_dotenv()

    args = parse_args()
    if not args.perf and not args.results:
        print("Please specify --perf or --results")
        exit(1)

    # Set default values if not provided
    if not args.head:
        args.head = "unstaged"  # Use unstaged changes by default
        print("Using unstaged changes for --head")

    if args.results and not args.base:
        args.base = get_latest_commit()  # Use latest commit as base by default
        print(f"Using latest commit for --base: {args.base}")

    if args.perf:
        perf_compare(args)
    if args.results:
        results_compare(args)
