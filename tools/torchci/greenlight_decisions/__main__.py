"""Export one CSV row per pull request greenlight has evaluated.

Reads the verdicts and PR metadata from ClickHouse, then measures the size of
the diff each verdict actually judged via the GitHub compare API. See README.md
for what the columns do and do not mean.
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, TYPE_CHECKING

from torchci.greenlight_decisions.loc import (
    compute_loc,
    LOC_STATUS_MISSING_SHA,
    LOC_STATUS_OK,
)
from torchci.greenlight_decisions.query import DEFAULT_REPO, fetch_decisions
from torchci.greenlight_decisions.rows import (
    blank_loc,
    build_row,
    format_timestamp,
    to_utc_naive,
    write_csv,
)


if TYPE_CHECKING:
    from clickhouse_connect.driver.client import Client


LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"
PROGRESS_INTERVAL = 25
MAX_LOC_STATUS_CHARS = 200

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_DEGRADED = 3

# Above this share of attempted measurements failing, the GitHub side is down
# rather than one pull request being awkward, and the LOC columns describe
# nothing. One flaky PR in a full run is under 1%.
LOC_FAILURE_ABORT_RATIO = 0.5

logger = logging.getLogger(__name__)


def parse_as_of(text: str) -> datetime:
    normalized = text.strip()
    if normalized.endswith(("Z", "z")):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"not an ISO-8601 timestamp: {text!r} ({exc})"
        ) from exc
    return to_utc_naive(parsed)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="greenlight_decisions",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--repo",
        default=DEFAULT_REPO,
        help=f"owner/name to export (default: {DEFAULT_REPO})",
    )
    parser.add_argument(
        "--as-of",
        type=parse_as_of,
        default=None,
        help="ISO-8601 timestamp; ignore greenlight state written after it. "
        "Pins ClickHouse only, not the live GitHub reads (default: now)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="CSV destination (default: greenlight_decisions_<as-of>.csv)",
    )
    parser.add_argument(
        "--skip-loc",
        action="store_true",
        help="skip the GitHub compare calls and leave the LOC columns blank",
    )
    return parser


def connect() -> Client:
    """Open the ClickHouse client.

    The driver import is deferred so that importing this module -- to inspect the
    parser, or to exercise row assembly -- does not require clickhouse_connect to
    be installed. Nothing else here touches ClickHouse.
    """
    from torchci.clickhouse import get_clickhouse_client

    return get_clickhouse_client()


def default_output_path(as_of: datetime) -> str:
    stamp = format_timestamp(as_of).replace("-", "").replace(":", "")
    return f"greenlight_decisions_{stamp}.csv"


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT, stream=sys.stdout)

    as_of = (
        args.as_of
        if args.as_of is not None
        else to_utc_naive(datetime.now(timezone.utc))
    )
    snapshot_at = format_timestamp(as_of)
    output = args.output or default_output_path(as_of)
    logger.info("exporting %s as of %s to %s", args.repo, snapshot_at, output)

    try:
        client = connect()
    except Exception as exc:
        logger.error("could not connect to ClickHouse: %s", exc, exc_info=True)
        return EXIT_FAILED

    try:
        decisions = fetch_decisions(client, args.repo, as_of)
    except Exception as exc:
        logger.error("ClickHouse query failed: %s", exc, exc_info=True)
        return EXIT_FAILED

    if not decisions:
        logger.error(
            "no greenlight state rows for %s as of %s; nothing to export",
            args.repo,
            snapshot_at,
        )
        return EXIT_FAILED

    rows = collect_rows(args.repo, decisions, snapshot_at, skip_loc=args.skip_loc)
    try:
        written = write_csv(output, rows)
    except Exception as exc:
        logger.error("could not write %s: %s", output, exc, exc_info=True)
        return EXIT_FAILED
    log_summary(output, written, rows)
    return EXIT_OK if loc_is_trustworthy(rows) else EXIT_DEGRADED


def collect_rows(
    repo: str,
    decisions: Sequence[Mapping[str, Any]],
    snapshot_at: str,
    skip_loc: bool,
) -> List[Dict[str, Any]]:
    total = len(decisions)
    rows: List[Dict[str, Any]] = []
    for index, decision in enumerate(decisions, start=1):
        measure = not skip_loc and bool(decision.get("decision"))
        loc = measure_loc(repo, decision) if measure else None
        rows.append(build_row(decision, loc, snapshot_at))
        if not skip_loc and (index % PROGRESS_INTERVAL == 0 or index == total):
            logger.info("LOC %d/%d", index, total)
    return rows


def measure_loc(repo: str, decision: Mapping[str, Any]) -> Dict[str, Any]:
    """Size the judged diff for one PR. Never raises: a failure is a cell value."""
    base_sha = decision.get("base_sha") or ""
    judged_head_sha = decision.get("decision_head_sha") or ""
    if not base_sha or not judged_head_sha:
        return blank_loc(LOC_STATUS_MISSING_SHA)
    try:
        return dict(
            compute_loc(
                repo,
                base_sha,
                judged_head_sha,
                decision.get("final_head_sha") or "",
            )
        )
    except Exception as exc:
        logger.warning(
            "LOC lookup failed for PR %s: %s",
            decision.get("pr_number"),
            exc,
            exc_info=True,
        )
        return blank_loc(_error_status(exc))


def loc_is_trustworthy(rows: Sequence[Mapping[str, Any]]) -> bool:
    """Whether enough LOC measurements succeeded for the columns to mean anything.

    A single failing pull request degrades one row and is expected. GitHub being
    unreachable degrades every row while each one still carries a definite-looking
    staleness value, so that case has to be visible in the exit status.
    """
    attempted, failed = _loc_tally(rows)
    if not attempted:
        return True
    return failed / attempted <= LOC_FAILURE_ABORT_RATIO


def log_summary(output: str, written: int, rows: Sequence[Mapping[str, Any]]) -> None:
    logger.info("wrote %d rows to %s", written, output)
    staleness = Counter(row["verdict_staleness"] or "(blank)" for row in rows)
    logger.info("verdict_staleness: %s", _format_counts(staleness))
    problems = Counter(
        row["loc_status"]
        for row in rows
        if row["loc_status"] not in ("", LOC_STATUS_OK)
    )
    attempted, failed = _loc_tally(rows)
    if problems:
        logger.warning(
            "non-ok loc_status on %d of %d measured PRs: %s",
            failed,
            attempted,
            _format_counts(problems),
        )
    else:
        logger.info("loc_status: no failures")
    if not loc_is_trustworthy(rows):
        logger.error(
            "%d of %d LOC measurements failed; the LOC and verdict_staleness "
            "columns describe the failure, not the pull requests",
            failed,
            attempted,
        )


def _loc_tally(rows: Sequence[Mapping[str, Any]]) -> tuple:
    """(attempted, failed) LOC measurements. A blank status was never attempted."""
    attempted = [row["loc_status"] for row in rows if row["loc_status"] != ""]
    return len(attempted), sum(1 for s in attempted if s != LOC_STATUS_OK)


def _error_status(exc: Exception) -> str:
    detail = " ".join(f"error: {type(exc).__name__}: {exc}".split())
    return detail[:MAX_LOC_STATUS_CHARS]


def _format_counts(counts: Counter) -> str:
    ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return ", ".join(f"{name}={count}" for name, count in ordered) or "(none)"


if __name__ == "__main__":
    sys.exit(main())
