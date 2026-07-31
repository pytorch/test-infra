import argparse
import csv
import logging
import sys
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Set, Tuple

from dotenv import load_dotenv  # type: ignore[import-not-found]

from .client import get_clickhouse_client
from .logic import build_rows, COLUMNS, iter_time_chunks
from .premerge import (
    classify_with_context,
    parse_pr_from_message,
    PremergeContext,
    resolve_premerge_context,
)
from .queries import (
    fetch_advisor_verdicts,
    fetch_commit_messages,
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

    flaky: Dict[str, Set[Tuple[str, str]]] = {}
    flaky_start = args.start - timedelta(days=FLAKY_PAD_DAYS)
    flaky_end = args.end + timedelta(days=FLAKY_PAD_DAYS)
    for chunk_start, chunk_end in iter_time_chunks(
        flaky_start, flaky_end, FLAKY_CHUNK_HOURS
    ):
        for workflow, signal_key, commit_sha in fetch_flaky_for_day(
            client, args.repo, chunk_start, chunk_end
        ):
            flaky.setdefault(commit_sha, set()).add((workflow, signal_key))
        n_pairs = sum(len(v) for v in flaky.values())
        logging.info(
            "flaky scan %s: %d distinct (workflow, signal) pairs so far",
            chunk_start.isoformat(),
            n_pairs,
        )

    candidate_shas = sorted(set(regressions.by_commit) | set(flaky))
    commit_times = fetch_commit_times(client, candidate_shas)

    regression_shas = sorted(regressions.by_commit)
    verdicts = fetch_advisor_verdicts(client, args.repo, regression_shas)

    rows = build_rows(
        regressions.by_commit,
        regressions.single_workflow,
        flaky,
        commit_times,
        verdicts,
        args.start,
        args.end,
        args.repo,
    )

    # Only trunk+pull regressions get a premerge lookup; everything else stays "".
    qualifying = [
        r
        for r in rows
        if r["category"] == "regression" and r["workflow"] in ("trunk", "pull")
    ]
    msg_shas = sorted({r["commit_sha"] for r in qualifying})
    messages = fetch_commit_messages(client, msg_shas) if msg_shas else {}

    # Initialize every row so csv.DictWriter always has the premerge_status field.
    for r in rows:
        r["premerge_status"] = ""

    total = len(qualifying)
    # head_sha/merge_ts/job_ids depend only on the commit, so resolve the per-commit
    # context once and reuse it for every failing signal on that commit.
    context_cache: Dict[str, PremergeContext] = {}
    for i, r in enumerate(qualifying, start=1):
        file, sep, name = r["signal_key"].partition("::")
        if not sep:
            continue
        message = messages.get(r["commit_sha"], "")
        pr = parse_pr_from_message(message)
        context = context_cache.get(r["commit_sha"])
        if context is None:
            context = resolve_premerge_context(client, r["commit_sha"], repo=args.repo)
            context_cache[r["commit_sha"]] = context
        status = classify_with_context(client, context, file, name)
        r["premerge_status"] = status
        logging.info(
            "premerge %d/%d commit=%s pr=%s signal=%s -> %s",
            i,
            total,
            r["commit_sha"][:10],
            pr,
            r["signal_key"],
            status,
        )

    return rows


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

    n_reg = sum(1 for r in rows if r["category"] == "regression")
    n_flaky = sum(1 for r in rows if r["category"] == "flaky")
    n_commits = len({r["commit_sha"] for r in rows})
    print(output)
    print(
        f"{len(rows)} rows across {n_commits} commits: "
        f"{n_reg} regression, {n_flaky} flaky"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
