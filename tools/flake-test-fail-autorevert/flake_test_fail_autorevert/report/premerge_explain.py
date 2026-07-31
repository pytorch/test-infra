from .htmlutil import escape


_REASON_ROWS = [
    (
        "no_merge_record",
        "couldn't look",
        "No merge record identified which pre-merge version to check - a "
        "stacked-PR commit that isn't the top of its stack, a revert, or a "
        "direct push. Status is unknown (a tool limitation, not a CI fact).",
    ),
    (
        "force_merge",
        "gate bypassed",
        "The change was force-merged (-f), so the required checks never ran "
        "this test before it landed. A process finding.",
    ),
    (
        "not_in_matrix",
        "job wasn't in the matrix",
        "The gate ran, but this test's whole job/config was not part of the "
        "pre-merge checks - nothing from its file ran. A coverage gap.",
    ),
    (
        "td_deselected",
        "TD excluded the file",
        "Target determination excluded the failing test's whole file from "
        "the pre-merge run (it predicts which files a change affects and "
        "skips the rest), so the file - and this test - never ran. A real "
        "file-level coverage gap; re-running isn't guaranteed to reproduce "
        "(landraces), but the file never got the chance.",
    ),
    (
        "test_absent",
        "file ran, test left no result",
        "The file's job ran and TD did not exclude it, but this specific "
        "test produced no result row - typically a renamed, removed, or "
        "reparametrized test, or a shard/job-filter edge. Not a TD "
        "decision.",
    ),
    (
        "td_unknown",
        "no result, TD undetermined",
        "This test produced no pre-merge result and we could not determine "
        "whether target determination excluded its file. A no-result test "
        "of undetermined cause; a minority of cases land here.",
    ),
    (
        "skipped",
        "test reached, but opted out",
        "The test was in the run but explicitly skipped (a skip condition / "
        "platform guard), so it produced no pass/fail. Usually intentional.",
    ),
]


def render_explanation() -> str:
    body = "".join(
        f"<tr><td><code>NOT_RUN:{escape(key)}</code></td>"
        f"<td>{escape(short)}</td><td>{escape(desc)}</td></tr>"
        for key, short, desc in _REASON_ROWS
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
        '<p class="model"><code>td_deselected</code>, <code>not_in_matrix</code>, '
        "and <code>test_absent</code> are the true test-coverage gaps worth "
        "chasing (the failing test never produced a pre-merge result); "
        "<code>td_unknown</code> is the same but with an undetermined cause. "
        "<code>force_merge</code> is a process signal, <code>skipped</code> is "
        "usually intentional, and <code>no_merge_record</code> is a tool "
        "blind spot.</p>"
        "</div>"
    )
