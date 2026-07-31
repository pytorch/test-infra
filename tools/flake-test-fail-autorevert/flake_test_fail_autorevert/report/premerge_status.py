from typing import Dict


PREMERGE_STATUS_TD_DESELECTED = "NOT_RUN:td_deselected"
PREMERGE_STATUS_TEST_ABSENT = "NOT_RUN:test_absent"
PREMERGE_STATUS_TD_UNKNOWN = "NOT_RUN:td_unknown"
PREMERGE_STATUS_RUN_SUCCEEDED = "RUN_SUCCEEDED"
PREMERGE_STATUS_RUN_FAILED = "RUN_FAILED"
PREMERGE_STATUS_FORCE_MERGE = "NOT_RUN:force_merge"
PREMERGE_STATUS_NO_MERGE_RECORD = "NOT_RUN:no_merge_record"
PREMERGE_STATUS_ERROR = "ERROR"
PREMERGE_STATUS_SKIPPED = "NOT_RUN:skipped"
PREMERGE_STATUS_NOT_IN_MATRIX = "NOT_RUN:not_in_matrix"


# Plain-language explanation of every pre-merge status, keyed once here so the
# breakdown rows, funnel drops, and table headings share one source of truth.
# ASCII-only so they escape cleanly into HTML attributes.
PREMERGE_STATUS_TOOLTIPS: Dict[str, str] = {
    PREMERGE_STATUS_RUN_SUCCEEDED: (
        "This test ran while the change was still a pull request and passed "
        "there. It only started failing after the change landed on main - "
        "usually a 'landrace': the change was fine on its own but broke when "
        "combined with another change that merged around the same time."
    ),
    PREMERGE_STATUS_RUN_FAILED: (
        "This test already failed while the change was still a pull request, "
        "yet it was merged anyway. The breakage was visible in CI before it "
        "landed."
    ),
    PREMERGE_STATUS_FORCE_MERGE: (
        "The change was merged without waiting for the required CI checks (a "
        "force-merge / '-f'), so this test never ran before it landed."
    ),
    PREMERGE_STATUS_SKIPPED: (
        "The test was present in the pre-merge run but was explicitly skipped, "
        "so it produced no pass/fail result before merge."
    ),
    PREMERGE_STATUS_TD_DESELECTED: (
        "Target determination (TD) excluded the failing test's file from the "
        "pre-merge run - TD predicts which files a change can affect and skips "
        "the rest - so the file, and this test, never ran before merge. "
        "Re-running is not guaranteed to reproduce the failure (landraces "
        "exist), but the file was never given the chance."
    ),
    PREMERGE_STATUS_TEST_ABSENT: (
        "The test's file ran before merge, but this specific test produced no "
        "result row and was not excluded by target determination - usually a "
        "renamed, removed, or reparametrized test, or a shard/job-filter edge. "
        "No pre-merge pass/fail exists for it."
    ),
    PREMERGE_STATUS_TD_UNKNOWN: (
        "This test produced no pre-merge result, and we could not determine "
        "whether target determination excluded its file - a no-result test of "
        "undetermined cause."
    ),
    PREMERGE_STATUS_NOT_IN_MATRIX: (
        "The test's job/configuration didn't run before merge at all - it "
        "wasn't part of this pull request's checks, even though other checks "
        "did run."
    ),
    PREMERGE_STATUS_NO_MERGE_RECORD: (
        "We couldn't identify which pre-merge version to check for this commit "
        "- e.g. a stacked-PR commit that isn't the top of its stack, a revert, "
        "or a direct push. Pre-merge status is unknown."
    ),
    PREMERGE_STATUS_ERROR: (
        "The query that determines pre-merge status failed, so the status is "
        "unknown for this row."
    ),
}


# Explanation for the funnel's "couldn't determine" drop, kept alongside the
# per-status tooltips so all hover text is single-sourced.
PREMERGE_TOOLTIP_UNDETERMINED = (
    "Pre-merge status couldn't be determined: either no pre-merge version "
    "could be identified, or the lookup failed."
)
