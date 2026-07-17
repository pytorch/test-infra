import argparse
import io
import logging
import os
import sys
from typing import List, Optional

from .aggregate import aggregate
from .assets import get_chartjs
from .load import ReportInputError, load_records
from .render import render


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="flake-report",
        description=(
            "Render a self-contained HTML report from a flake-test-fail-autorevert "
            "CSV (flakiness and regression rankings and time-series)."
        ),
    )
    parser.add_argument("--input", required=True, help="path to the source CSV")
    parser.add_argument(
        "--output",
        default=None,
        help="output HTML path (default: <input-basename>.report.html)",
    )
    parser.add_argument(
        "--title", default="Autorevert flakiness & regressions", help="report title"
    )
    parser.add_argument(
        "--top", type=int, default=50, help="rows per ranking table (default 50)"
    )
    parser.add_argument(
        "--no-charts",
        action="store_true",
        help="skip fetching/inlining Chart.js (tables-only output)",
    )
    args = parser.parse_args(argv)
    if args.top < 1:
        parser.error(f"--top ({args.top}) must be >= 1")
    return args


def default_output(input_path: str) -> str:
    base = os.path.basename(input_path)
    stem = base[:-4] if base.lower().endswith(".csv") else base
    return f"{stem}.report.html"


def _read_input(input_path: str) -> str:
    if not os.path.isfile(input_path):
        raise SystemExit(f"error: --input not found or not a file: {input_path}")
    try:
        with open(input_path, "r", encoding="utf-8-sig", newline="") as f:
            return f.read()
    except (OSError, UnicodeError) as exc:
        raise SystemExit(f"error: cannot read --input {input_path}: {exc}")


def main(argv: Optional[List[str]] = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )
    args = parse_args(argv)

    text = _read_input(args.input)
    try:
        records = load_records(io.StringIO(text))
    except ReportInputError as exc:
        raise SystemExit(f"error: {exc}")

    datasets = aggregate(records, source=os.path.basename(args.input))
    chartjs = get_chartjs(args.no_charts)
    html = render(datasets, title=args.title, chartjs=chartjs, top=args.top)

    output = args.output or default_output(args.input)
    try:
        with open(output, "w", encoding="utf-8") as f:
            f.write(html)
    except OSError as exc:
        raise SystemExit(f"error: cannot write --output {output}: {exc}")

    meta = datasets.meta
    charts_state = "embedded" if chartjs is not None else "unavailable (tables-only)"
    print(output)
    print(
        f"{meta.total_rows} rows, {meta.distinct_commits} commits, "
        f"{meta.regression_rows} regressions, {meta.flaky_rows} flaky; "
        f"charts {charts_state}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
