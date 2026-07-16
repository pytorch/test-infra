import argparse
import csv
import logging
import sys
from datetime import date, datetime, timedelta
from typing import List, Optional

from dotenv import load_dotenv

from .client import get_clickhouse_client
from .logic import COLUMNS, build_rows, iter_time_chunks
from .queries import (
    fetch_advisor_verdicts,
    fetch_commit_times,
    fetch_flaky_for_day,
    fetch_regressions,
)

EVENT_PAD_DAYS = 2
FLAKY_PAD_DAYS = 1
FLAKY_CHUNK_HOURS = 6


def parse_date(value: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"invalid date '{value}', expected YYYY-MM-DD"
        ) from exc


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="flake_test_fail_autorevert",
        description=(
            "Export pytorch-auto-revert's published test decisions (regression "
            "reverts and flaky-flagged test signals) to CSV for a commit landing "
            "range on main."
        ),
    )
    parser.add_argument("--start", type=parse_date, required=True, help="YYYY-MM-DD")
    parser.add_argument(
        "--end", type=parse_date, required=True, help="YYYY-MM-DD (inclusive)"
    )
    parser.add_argument("--repo", default="pytorch/pytorch")
    parser.add_argument("--output", default=None)
    args = parser.parse_args(argv)
    if args.start > args.end:
        parser.error(f"--start ({args.start}) must be <= --end ({args.end})")
    return args


def default_output(start: date, end: date) -> str:
    return f"flake_test_fail_autorevert_{start.isoformat()}_{end.isoformat()}.csv"


def write_csv(path: str, rows: List[dict]) -> None:
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        writer.writerows(rows)


def collect(args: argparse.Namespace) -> List[dict]:
    client = get_clickhouse_client()

    ev_start = datetime.combine(
        args.start - timedelta(days=EVENT_PAD_DAYS), datetime.min.time()
    )
    ev_end = datetime.combine(
        args.end + timedelta(days=EVENT_PAD_DAYS + 1), datetime.min.time()
    )
    regressions = fetch_regressions(client, args.repo, ev_start, ev_end)

    flaky: dict = {}
    flaky_start = args.start - timedelta(days=FLAKY_PAD_DAYS)
    flaky_end = args.end + timedelta(days=FLAKY_PAD_DAYS)
    for chunk_start, chunk_end in iter_time_chunks(
        flaky_start, flaky_end, FLAKY_CHUNK_HOURS
    ):
        for commit_sha, signal_key in fetch_flaky_for_day(
            client, args.repo, chunk_start, chunk_end
        ):
            flaky.setdefault(commit_sha, set()).add(signal_key)
        n_pairs = sum(len(v) for v in flaky.values())
        logging.info(
            "flaky scan %s: %d distinct (commit, signal) pairs so far",
            chunk_start.isoformat(),
            n_pairs,
        )

    candidate_shas = sorted(set(regressions) | set(flaky))
    commit_times = fetch_commit_times(client, candidate_shas)

    regression_shas = sorted(regressions)
    verdicts = fetch_advisor_verdicts(client, args.repo, regression_shas)

    return build_rows(
        regressions,
        flaky,
        commit_times,
        verdicts,
        args.start,
        args.end,
        args.repo,
    )


def main(argv: Optional[List[str]] = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )
    load_dotenv()
    args = parse_args(argv)

    rows = collect(args)

    output = args.output or default_output(args.start, args.end)
    write_csv(output, rows)

    n_reg = sum(1 for r in rows if r["regressions"])
    n_flaky = sum(1 for r in rows if r["flaky_signals"])
    print(output)
    print(
        f"{len(rows)} commits, {n_reg} with regressions, {n_flaky} with flaky signals"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
