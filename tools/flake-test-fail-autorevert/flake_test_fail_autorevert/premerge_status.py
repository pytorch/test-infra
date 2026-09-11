"""Single source of truth for the pre-merge trunk-gate status vocabulary.

Both the generator (`premerge.py`, which EMITS these values into the CSV) and the
report subpackage (which renders and buckets them) import the constants from here, so
the string values are defined exactly once. `KNOWN_STATUSES` is the closed set of values
`premerge.py` can emit; the report's tooltip map keys must equal this set.
"""

from typing import FrozenSet


PREMERGE_STATUS_RUN_SUCCEEDED = "RUN_SUCCEEDED"
PREMERGE_STATUS_RUN_FAILED = "RUN_FAILED"
PREMERGE_STATUS_FORCE_MERGE = "NOT_RUN:force_merge"
PREMERGE_STATUS_SKIPPED = "NOT_RUN:skipped"
PREMERGE_STATUS_TD_EXCLUDED = "NOT_RUN:td_excluded"
PREMERGE_STATUS_TEST_ABSENT = "NOT_RUN:test_absent"
PREMERGE_STATUS_TD_UNKNOWN = "NOT_RUN:td_unknown"
PREMERGE_STATUS_NOT_IN_MATRIX = "NOT_RUN:not_in_matrix"
PREMERGE_STATUS_NO_MERGE_RECORD = "NOT_RUN:no_merge_record"
PREMERGE_STATUS_ERROR = "ERROR"


KNOWN_STATUSES: FrozenSet[str] = frozenset(
    {
        PREMERGE_STATUS_RUN_SUCCEEDED,
        PREMERGE_STATUS_RUN_FAILED,
        PREMERGE_STATUS_FORCE_MERGE,
        PREMERGE_STATUS_SKIPPED,
        PREMERGE_STATUS_TD_EXCLUDED,
        PREMERGE_STATUS_TEST_ABSENT,
        PREMERGE_STATUS_TD_UNKNOWN,
        PREMERGE_STATUS_NOT_IN_MATRIX,
        PREMERGE_STATUS_NO_MERGE_RECORD,
        PREMERGE_STATUS_ERROR,
    }
)
