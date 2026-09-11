"""Pure pre-merge status decisions from already-resolved per-commit data (no IO).

Kept apart from premerge.py's query/resolution orchestration so the classification rules
stay unit-testable against plain data. `classify_counts` turns a test's aggregated run
counts into a verdict; `_classify_no_result` attributes a no-result regression test to
td_excluded / test_absent / not_in_matrix / td_unknown using the pre-merge pull run's TD
exclusions, the (build_env, test_config) set that actually RAN in that run, and the configs
where the test FAILED on main.
"""

from typing import Optional, Set, Tuple

from .premerge_status import (
    PREMERGE_STATUS_NOT_IN_MATRIX,
    PREMERGE_STATUS_RUN_FAILED,
    PREMERGE_STATUS_RUN_SUCCEEDED,
    PREMERGE_STATUS_SKIPPED,
    PREMERGE_STATUS_TD_EXCLUDED,
    PREMERGE_STATUS_TD_UNKNOWN,
    PREMERGE_STATUS_TEST_ABSENT,
)
from .td_exclusions import ExclusionMap, flat_excluded_files, normalize_test_file


def classify_counts(fails: int, successes: int, skips: int) -> Optional[str]:
    """Classify a test's pre-merge outcome from aggregated run counts.
    Failure is checked BEFORE success so a mixed shard set where any shard failed is
    reported as RUN_FAILED (the 'merged despite red' signal) rather than masked by a
    passing retry. Returns None when there are no pass/fail/skip rows (caller resolves the
    no-result attribution: td_excluded / test_absent / not_in_matrix / td_unknown)."""
    if fails > 0:
        return PREMERGE_STATUS_RUN_FAILED
    if successes > 0:
        return PREMERGE_STATUS_RUN_SUCCEEDED
    if skips > 0:
        return PREMERGE_STATUS_SKIPPED
    return None


def _classify_no_result(
    excl: Optional[ExclusionMap],
    failing_configs: Set[Tuple[str, str]],
    pull_configs: Set[Tuple[str, str]],
    file: str,
) -> str:
    """Attribution for a regression test with NO pre-merge result row.
    `excl` is the pre-merge pull exclusion map (None when unresolvable); `failing_configs`
    is the (build_env, test_config) set where it FAILED on main; `pull_configs` is the set
    that actually RAN in that pull run (empty = matrix unknown). Unresolved map or no failing
    config -> td_unknown. td_excluded is decided first, and never changes: the file was
    TD-deselected from a failing config (per-config membership, unioned with the flat sentinel
    list so a standalone or mixed flat artifact still matches file-level). Otherwise matrix
    membership decides, read ONLY from pull_configs (the exclusion artifact omits configs that
    excluded no files, so it cannot answer it): a failing config that RAN -> test_absent; one
    that did not -> not_in_matrix; an unknown matrix (empty pull_configs) -> td_unknown."""
    if excl is None or not failing_configs:
        return PREMERGE_STATUS_TD_UNKNOWN
    normalized = normalize_test_file(file)
    if normalized in flat_excluded_files(excl) or any(
        normalized in excl.get(config, frozenset()) for config in failing_configs
    ):
        return PREMERGE_STATUS_TD_EXCLUDED
    if not pull_configs:
        return PREMERGE_STATUS_TD_UNKNOWN
    if any(config in pull_configs for config in failing_configs):
        return PREMERGE_STATUS_TEST_ABSENT
    return PREMERGE_STATUS_NOT_IN_MATRIX
