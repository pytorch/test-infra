from ..premerge_status import (
    PREMERGE_STATUS_FORCE_MERGE,
    PREMERGE_STATUS_NO_MERGE_RECORD,
    PREMERGE_STATUS_NOT_IN_MATRIX,
    PREMERGE_STATUS_SKIPPED,
    PREMERGE_STATUS_TD_EXCLUDED,
    PREMERGE_STATUS_TD_UNKNOWN,
    PREMERGE_STATUS_TEST_ABSENT,
)
from .htmlutil import escape


_REASON_ROWS = [
    (
        PREMERGE_STATUS_NO_MERGE_RECORD,
        "couldn't look",
        "No merge record identified which pre-merge version to check - a "
        "stacked-PR commit that isn't the top of its stack, a revert, or a "
        "direct push. Status is unknown (a tool limitation, not a CI fact).",
    ),
    (
        PREMERGE_STATUS_FORCE_MERGE,
        "gate bypassed",
        "The change was force-merged (-f), so the required checks never ran "
        "this test before it landed. A process finding.",
    ),
    (
        PREMERGE_STATUS_NOT_IN_MATRIX,
        "config wasn't in the matrix",
        "The gate ran, but the failing test's configuration was never in the "
        "pre-merge (pull) matrix - e.g. a trunk- or CUDA-only config that only "
        "runs after merge - so nothing from its file ran. A coverage gap.",
    ),
    (
        PREMERGE_STATUS_TD_EXCLUDED,
        "TD excluded the file",
        "Target determination excluded the failing test's file from the "
        "pre-merge run for the config where it failed - it predicts which "
        "files a change affects and skips the rest, per config. A real "
        "coverage gap; re-running isn't guaranteed to reproduce (landraces), "
        "but the file never got the chance.",
    ),
    (
        PREMERGE_STATUS_TEST_ABSENT,
        "file ran, test left no result",
        "The failing test's config ran its file and target determination did "
        "NOT exclude it, but this specific test produced no result row - "
        "typically a renamed, removed, or reparametrized test, or a "
        "shard/job-filter edge. Not a TD decision.",
    ),
    (
        PREMERGE_STATUS_TD_UNKNOWN,
        "no result, TD undetermined",
        "This test produced no pre-merge result and TD's per-config decision "
        "could not be determined - no usable exclusion artifact, or a flat "
        "artifact that didn't list the file. A no-result test of undetermined "
        "cause; a minority of cases land here.",
    ),
    (
        PREMERGE_STATUS_SKIPPED,
        "test reached, but opted out",
        "The test was in the run but explicitly skipped (a skip condition / "
        "platform guard), so it produced no pass/fail. Usually intentional.",
    ),
]


def _code(status: str) -> str:
    return f"<code>{escape(status)}</code>"


def render_explanation() -> str:
    body = "".join(
        f"<tr><td>{_code(status)}</td>"
        f"<td>{escape(short)}</td><td>{escape(desc)}</td></tr>"
        for status, short, desc in _REASON_ROWS
    )
    return (
        '<div class="explain">'
        "<h3>What the NOT_RUN reasons mean</h3>"
        '<p class="model">All NOT_RUN reasons mean the test produced no pass/fail '
        "before merge - they differ by <em>where in the pipeline it dropped "
        "out</em>. The funnel above is that pipeline: each stage must pass to "
        "reach the next.</p>"
        "<table><thead><tr><th>Reason</th><th>In one phrase</th>"
        "<th>What happened</th></tr></thead><tbody>" + body + "</tbody></table>"
        f'<p class="model">{_code(PREMERGE_STATUS_TD_EXCLUDED)}, '
        f"{_code(PREMERGE_STATUS_NOT_IN_MATRIX)}, and "
        f"{_code(PREMERGE_STATUS_TEST_ABSENT)} are the true test-coverage gaps "
        "worth chasing (the failing test never produced a pre-merge result); "
        f"{_code(PREMERGE_STATUS_TD_UNKNOWN)} is the same but with an "
        f"undetermined cause. {_code(PREMERGE_STATUS_FORCE_MERGE)} is a process "
        f"signal, {_code(PREMERGE_STATUS_SKIPPED)} is usually intentional, and "
        f"{_code(PREMERGE_STATUS_NO_MERGE_RECORD)} is a tool blind spot.</p>"
        "</div>"
    )
