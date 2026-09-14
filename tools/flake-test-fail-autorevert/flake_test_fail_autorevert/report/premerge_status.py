from typing import Dict

from ..premerge_status import (
    PREMERGE_STATUS_ERROR,
    PREMERGE_STATUS_FORCE_MERGE,
    PREMERGE_STATUS_NO_MERGE_RECORD,
    PREMERGE_STATUS_NOT_IN_MATRIX,
    PREMERGE_STATUS_RUN_FAILED,
    PREMERGE_STATUS_RUN_SUCCEEDED,
    PREMERGE_STATUS_SKIPPED,
    PREMERGE_STATUS_TD_EXCLUDED,
    PREMERGE_STATUS_TD_UNKNOWN,
    PREMERGE_STATUS_TEST_ABSENT,
)


# Plain-language explanation of every pre-merge status. Keys are the neutral
# status constants so the breakdown rows, funnel drops, and table headings share
# one vocabulary; values are ASCII-only so they escape cleanly into HTML attrs.
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
    PREMERGE_STATUS_TD_EXCLUDED: (
        "Target determination (TD) excluded the failing test's file from the "
        "pre-merge run for the configuration where it later failed - TD "
        "predicts which files a change can affect and skips the rest, per "
        "configuration - so the file, and this test, never ran before merge. "
        "This is the honest 'green would be red' signal; re-running is not "
        "guaranteed to reproduce the failure (landraces exist), but the file "
        "was never given the chance."
    ),
    PREMERGE_STATUS_TEST_ABSENT: (
        "The failing test's configuration ran its file before merge and target "
        "determination did NOT exclude it, but this specific test produced no "
        "result row - usually a renamed, removed, or reparametrized test, or a "
        "shard/job-filter edge. Not a TD decision; no pre-merge pass/fail "
        "exists for it."
    ),
    PREMERGE_STATUS_TD_UNKNOWN: (
        "This test produced no pre-merge result and TD's decision for its file "
        "could not be determined - no usable exclusion record, or a flat "
        "record that did not list the file. A no-result test of undetermined "
        "cause."
    ),
    PREMERGE_STATUS_NOT_IN_MATRIX: (
        "The failing test's config never ran in the pre-merge (pull) matrix - "
        "e.g. a trunk- or CUDA-only config that only runs after merge - so "
        "nothing from its file ran before the change landed."
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
