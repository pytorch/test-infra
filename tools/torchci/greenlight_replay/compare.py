"""Compare replay runs under a policy PR's base and head, as a PR comment.

The policy-replay workflow replays one sample of historical pull requests
several times under the policy at a test-infra PR's merge base and several
times under the PR's own policy. Each run is a directory holding the harness's
``replay.csv`` and its exit status. This entry point reads those directories,
pairs the arms with ``compare_stats`` and writes the markdown ``compare_render``
lays out: what each arm concluded, how much each disagreed with itself from run
to run, and which pull requests flipped between them.

Everything read here is untrusted: the runs executed hook scripts from the PR
under test and recorded model output. A ``Row`` therefore keeps only values that
pass validation -- the PR number, a verdict from ``DECISION_VALUES``, a reason
code of the harness's shape, the export's repo and SHA patterns -- and the prose
columns are never read. A run that is missing, failed or unreadable is recorded
as such rather than raised, so the comment is written whatever the runs did.
"""

from __future__ import annotations

import argparse
import csv
import logging
import os
import re
import sys
from collections.abc import Mapping, Sequence

from torchci.greenlight_decisions.loc import _REPO_PATTERN, _SHA_PATTERN
from torchci.greenlight_replay.cells import load_rows
from torchci.greenlight_replay.compare_render import render
from torchci.greenlight_replay.compare_stats import (
    compare,
    FAILED,
    INVALID_REASON,
    Row,
    Run,
)
from torchci.greenlight_replay.verdict_cells import (
    DECISION_VALUES,
    HARNESS_REASON_PREFIX,
)


LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"

EXIT_OK = 0
EXIT_FAILED = 1

CSV_FILE = "replay.csv"
EXIT_CODE_FILE = "exit-code"

NO_ARTIFACT = "no artifact"
NO_EXIT_CODE = "no exit code"
UNREADABLE_EXIT_CODE = "unreadable exit code"
NO_CSV = "no CSV"
UNREADABLE_CSV = "unreadable CSV"

REASON_PATTERN = re.compile(rf"(?:{re.escape(HARNESS_REASON_PREFIX)})?[a-z][a-z0-9_]*")
RUN_URL_PATTERN = re.compile(
    rf"https://github\.com/{_REPO_PATTERN.pattern}/actions/runs/[0-9]+"
    r"(?:/attempts/[0-9]+)?"
)

# Bounded so that a hostile cell can never reach int()'s digit limit, which
# raises instead of letting the row be skipped.
_PR_NUMBER = re.compile(r"[1-9][0-9]{0,9}")
_LABEL_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")

logger = logging.getLogger(__name__)


def load_run(path: str) -> Run:
    """Read one run directory, recording rather than raising whatever is wrong."""
    label = run_label(path)
    if not os.path.isdir(path):
        logger.warning("run %s: no directory at %s", label, path)
        return Run(label, exit_note=NO_ARTIFACT, csv_note=NO_CSV)
    exit_code, exit_note = read_exit_code(label, os.path.join(path, EXIT_CODE_FILE))
    rows, skipped, csv_note = read_rows(label, os.path.join(path, CSV_FILE))
    return Run(label, exit_code, exit_note, csv_note, rows, skipped)


def run_label(path: str) -> str:
    name = os.path.basename(os.path.normpath(path))
    return _LABEL_UNSAFE.sub("-", name).strip("-") or "run"


def read_exit_code(label: str, path: str) -> tuple[int | None, str]:
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except FileNotFoundError:
        logger.warning("run %s: no exit status at %s", label, path)
        return None, NO_EXIT_CODE
    except (OSError, UnicodeDecodeError) as exc:
        logger.warning("run %s: could not read %s: %s", label, path, exc, exc_info=True)
        return None, UNREADABLE_EXIT_CODE
    try:
        return int(text.strip()), ""
    except ValueError:
        logger.warning("run %s: %s holds no exit status: %.40r", label, path, text)
        return None, UNREADABLE_EXIT_CODE


def read_rows(label: str, path: str) -> tuple[dict[int, Row], int, str]:
    """The rows by PR number, how many were skipped, and why there are none, if so."""
    if not os.path.isfile(path):
        logger.warning("run %s: no %s", label, path)
        return {}, 0, NO_CSV
    try:
        loaded = load_rows(path)
    except (OSError, UnicodeDecodeError, csv.Error) as exc:
        logger.error("run %s: could not read %s: %s", label, path, exc, exc_info=True)
        return {}, 0, UNREADABLE_CSV
    rows: dict[int, Row] = {}
    skipped = 0
    for index, cells in enumerate(loaded, start=1):
        number = pr_number(cells.get("pr_number"))
        if number is None:
            logger.warning(
                "run %s: row %d has no readable pr_number: %.40r",
                label,
                index,
                cells.get("pr_number"),
            )
            skipped += 1
        elif number in rows:
            logger.warning(
                "run %s: row %d repeats PR %d; keeping the first", label, index, number
            )
            skipped += 1
        else:
            rows[number] = parse_row(cells)
    return rows, skipped, ""


def pr_number(cell: str | None) -> int | None:
    text = (cell or "").strip()
    return int(text) if _PR_NUMBER.fullmatch(text) else None


def parse_row(cells: Mapping[str, str]) -> Row:
    """Validate one row's cells, keeping nothing that fails.

    A ``harness:`` reason makes the row a failure even when ``new_decision``
    carries a status: a payload the policy's schema rejected keeps its status
    there, and that status is not a verdict the policy stands behind.
    """
    reason = _cell(cells, "new_decision_reason")
    verdict = _cell(cells, "new_decision")
    if verdict not in DECISION_VALUES or reason.startswith(HARNESS_REASON_PREFIX):
        verdict = FAILED
    return Row(
        verdict=verdict,
        reason=reason if REASON_PATTERN.fullmatch(reason) else INVALID_REASON,
        repo=_valid(_cell(cells, "repo"), _REPO_PATTERN),
        head_sha=_valid(_cell(cells, "decision_head_sha"), _SHA_PATTERN),
    )


def _cell(cells: Mapping[str, str], column: str) -> str:
    return (cells.get(column) or "").strip()


def _valid(value: str, pattern: re.Pattern[str]) -> str:
    return value if pattern.fullmatch(value) else ""


def commit_sha(text: str) -> str:
    if not _SHA_PATTERN.fullmatch(text):
        raise argparse.ArgumentTypeError(
            f"must be a full lowercase hex commit SHA: {text!r}"
        )
    return text


def run_url(text: str) -> str:
    if not RUN_URL_PATTERN.fullmatch(text):
        raise argparse.ArgumentTypeError(
            f"must be https://github.com/<owner>/<repo>/actions/runs/<id>: {text!r}"
        )
    return text


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="greenlight_replay.compare",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    for flag, policy in (
        ("--base", "the base policy"),
        ("--change", "the PR's policy"),
    ):
        parser.add_argument(
            flag,
            nargs="+",
            required=True,
            metavar="RUN_DIR",
            help=f"run directories replayed under {policy}, in run order",
        )
    parser.add_argument(
        "--base-sha", type=commit_sha, required=True, help="the PR's merge base"
    )
    parser.add_argument(
        "--head-sha", type=commit_sha, required=True, help="the PR's head commit"
    )
    parser.add_argument(
        "--run-url", type=run_url, required=True, help="the workflow run to link to"
    )
    parser.add_argument("--output", required=True, help="markdown destination")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT, stream=sys.stdout)

    comparison = compare(
        [load_run(path) for path in args.base],
        [load_run(path) for path in args.change],
    )
    markdown = render(
        comparison, base_sha=args.base_sha, head_sha=args.head_sha, run_url=args.run_url
    )
    try:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(markdown)
    except OSError as exc:
        logger.error("could not write %s: %s", args.output, exc, exc_info=True)
        return EXIT_FAILED
    logger.info(
        "wrote %d characters to %s: %d PRs, %d comparable, %d true and %d non-true "
        "flips; runs with results: base %d of %d, this PR %d of %d",
        len(markdown),
        args.output,
        len(comparison.prs),
        len(comparison.comparable),
        len(comparison.true_flips),
        len(comparison.non_true_flips),
        comparison.base.runs_with_rows,
        len(comparison.base.runs),
        comparison.change.runs_with_rows,
        len(comparison.change.runs),
    )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
