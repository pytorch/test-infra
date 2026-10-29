"""The tables of the base-versus-PR replay comparison.

``compare_render`` lays out the comment; this module lays out its tables -- the
pull requests of each list, the reason codes and the health of each run -- and
the table and ``<details>`` markup both modules use. Every value it prints is a
number, a fixed string, a run label ``compare`` sanitized, the run URL
``compare`` validated, or a field of a ``Row``, which holds nothing that failed
validation, so nothing is escaped here either.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Sequence
from operator import attrgetter

from torchci.greenlight_replay.compare_stats import (
    Comparison,
    FAILED,
    LAND,
    NO_LAND,
    Pr,
    PrArm,
    Run,
)


Column = tuple[str, Callable[[Pr], str]]

# A github.com link to a pull request leaves a backlink on it; GitHub documents
# redirect.github.com as the way to link without one.
PR_URL = "https://redirect.github.com/{repo}/pull/{number}"
SEPARATOR = " · "
MISSING = "—"
BASE = "Base"
CHANGE = "This PR"

# The harness's exit codes (greenlight_replay.__main__.EXIT_*), restated because the
# entry point imports third-party packages and the report job installs none.
EXIT_MEANINGS = {0: "complete", 1: "failed", 3: "degraded"}


def _pr_link(pr: Pr) -> str:
    # A bare #N would autolink to issue N of the repository the comment is on.
    if not pr.repo:
        return f"`#{pr.number}`"
    return f"[#{pr.number}]({PR_URL.format(repo=pr.repo, number=pr.number)})"


def _outcomes(arm: PrArm) -> str:
    return SEPARATOR.join(
        MISSING if row is None else row.verdict for row in arm.outcomes
    )


def _reasons(arm: PrArm) -> str:
    return ", ".join(f"`{reason}`" for reason in arm.reasons) or MISSING


def _outcome_column(name: str, arm: Callable[[Pr], PrArm]) -> Column:
    return (name, lambda pr: _outcomes(arm(pr)))


def _reason_column(name: str, arm: Callable[[Pr], PrArm]) -> Column:
    return (f"{name} reasons", lambda pr: _reasons(arm(pr)))


_base = attrgetter("base")
_change = attrgetter("change")
PR_COLUMN: Column = ("PR", _pr_link)
FLIP_COLUMNS = (
    PR_COLUMN,
    _outcome_column(BASE, _base),
    _outcome_column(CHANGE, _change),
    _reason_column(BASE, _base),
    _reason_column(CHANGE, _change),
)
UNSTABLE_CHANGE_COLUMNS = (
    PR_COLUMN,
    _outcome_column(CHANGE, _change),
    _outcome_column(BASE, _base),
    _reason_column(CHANGE, _change),
)
UNSTABLE_BASE_COLUMNS = (
    PR_COLUMN,
    _outcome_column(BASE, _base),
    _outcome_column(CHANGE, _change),
    _reason_column(BASE, _base),
)
EXCLUDED_COLUMNS: tuple[Column, ...] = (PR_COLUMN, ("Why", attrgetter("exclusion")))


def pr_table(
    prs: Sequence[Pr], columns: Sequence[Column], cap: int | None, run_url: str
) -> str:
    if not prs:
        return "None."
    shown = prs if cap is None else prs[:cap]
    text = markdown_table(
        [name for name, _ in columns],
        [[cell(pr) for _, cell in columns] for pr in shown],
    )
    if len(prs) > len(shown):
        text += (
            f"\n\n...and {len(prs) - len(shown)} more (see the replay CSV artifacts "
            f"of the [workflow run]({run_url}))"
        )
    return text


def count_table(
    name: str, base: Counter[str], change: Counter[str], *, delta: bool
) -> str:
    keys = sorted(base.keys() | change.keys(), key=lambda k: (-base[k] - change[k], k))
    if not keys:
        return "None."
    rows = []
    for key in keys:
        row = [f"`{key}`", str(base[key]), str(change[key])]
        if delta:
            difference = change[key] - base[key]
            row.append(f"{difference:+d}" if difference else "0")
        rows.append(row)
    return markdown_table([name, BASE, CHANGE, *(["Change"] if delta else [])], rows)


def run_health(c: Comparison) -> str:
    rows = [
        [
            run.label,
            name,
            _exit(run),
            run.csv_note or _row_count(run),
            *(str(run.count(verdict)) for verdict in (LAND, NO_LAND, FAILED)),
            str(arm.missing_in(run)),
        ]
        for name, arm in ((BASE, c.base), (CHANGE, c.change))
        for run in arm.runs
    ]
    header = ["Run", "Arm", "Exit", "Rows", LAND, NO_LAND, "Failed", "Missing"]
    failures = count_table(
        "Failure reason",
        c.base.reasons(failed=True),
        c.change.reasons(failed=True),
        delta=False,
    )
    return details(
        "Run health",
        f"{markdown_table(header, rows)}\n\nHarness failures by reason:\n\n{failures}",
    )


def _exit(run: Run) -> str:
    if run.exit_code is None:
        return run.exit_note
    return f"{run.exit_code} {EXIT_MEANINGS.get(run.exit_code, 'other')}"


def _row_count(run: Run) -> str:
    return (
        f"{len(run.rows)} ({run.skipped} skipped)"
        if run.skipped
        else str(len(run.rows))
    )


def markdown_table(header: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    lines = [header, ["---"] * len(header), *rows]
    return "\n".join(f"| {' | '.join(line)} |" for line in lines)


def details(summary: str, body: str) -> str:
    # GitHub renders the markdown inside <details> only after a blank line.
    return f"<details><summary>{summary}</summary>\n\n{body}\n\n</details>"
