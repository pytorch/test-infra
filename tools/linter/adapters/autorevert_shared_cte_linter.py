"""Lintrunner adapter: keep the shared autorevert recovery-detection CTE block in sync.

`torchci/clickhouse_queries/autorevert_significant_reverts/query.sql` and
`torchci/clickhouse_queries/autorevert_weekly_metrics/query.sql` share a large
recovery-detection + causal-attribution pipeline (commits -> ... ->
recovery_with_attribution -> causally_attributed_recoveries). torchci has no SQL
include mechanism, so the block is physically duplicated in both files; only each
query's final aggregation differs.

To stop the two copies from silently drifting -- which already caused a stale-metric
bug, where the #8176 causal red-streak filter had to be applied to both files
separately -- the shared block is wrapped in

    -- @autorevert-shared-recovery-pipeline:begin
    ...
    -- @autorevert-shared-recovery-pipeline:end

markers in both files, and this check fails CI when the marked regions are not
byte-identical (or a marker is missing/duplicated). It also asserts the two
params.json files declare identical `params`, since the shared pipeline binds the
same parameters in both queries.

The check always compares the two canonical files regardless of which paths
lintrunner passes in, so editing either query (or either params.json) triggers it.
"""

import argparse
import json
import logging
from enum import Enum
from typing import List, NamedTuple, Optional, Tuple


LINTER_CODE = "AUTOREVERT_SHARED_CTE"

BEGIN_MARKER = "-- @autorevert-shared-recovery-pipeline:begin"
END_MARKER = "-- @autorevert-shared-recovery-pipeline:end"

QUERY_DIR = "torchci/clickhouse_queries"
SIGNIFICANT_SQL = f"{QUERY_DIR}/autorevert_significant_reverts/query.sql"
WEEKLY_SQL = f"{QUERY_DIR}/autorevert_weekly_metrics/query.sql"
SIGNIFICANT_PARAMS = f"{QUERY_DIR}/autorevert_significant_reverts/params.json"
WEEKLY_PARAMS = f"{QUERY_DIR}/autorevert_weekly_metrics/params.json"


class LintSeverity(str, Enum):
    ERROR = "error"
    WARNING = "warning"
    ADVICE = "advice"
    DISABLED = "disabled"


class LintMessage(NamedTuple):
    path: Optional[str]
    line: Optional[int]
    char: Optional[int]
    code: str
    severity: LintSeverity
    name: str
    original: Optional[str]
    replacement: Optional[str]
    description: Optional[str]


def _error(path: str, name: str, description: str) -> LintMessage:
    return LintMessage(
        path=path,
        line=None,
        char=None,
        code=LINTER_CODE,
        severity=LintSeverity.ERROR,
        name=name,
        original=None,
        replacement=None,
        description=description,
    )


def extract_shared_block(path: str) -> Tuple[Optional[str], Optional[str]]:
    """Return (block_text, error). block_text is None when an error is returned."""
    try:
        # newline="" disables universal-newline translation so a CRLF copy and an
        # LF copy do NOT compare equal -- the contract is literal byte identity.
        lines = open(path, encoding="utf-8", newline="").read().split("\n")
    except OSError as err:
        return None, f"could not read {path}: {err}"
    begins = [i for i, line in enumerate(lines) if line.strip() == BEGIN_MARKER]
    ends = [i for i, line in enumerate(lines) if line.strip() == END_MARKER]
    if len(begins) != 1 or len(ends) != 1:
        return None, (
            f"{path}: expected exactly one '{BEGIN_MARKER}' and one "
            f"'{END_MARKER}' line (found {len(begins)} begin, {len(ends)} end). "
            "These markers delimit the shared recovery-detection pipeline that must "
            "stay identical across the two autorevert metrics queries."
        )
    if ends[0] <= begins[0]:
        return None, f"{path}: '{END_MARKER}' appears before '{BEGIN_MARKER}'"
    return "\n".join(lines[begins[0] + 1 : ends[0]]), None


def read_params(path: str) -> Tuple[Optional[dict], Optional[str]]:
    try:
        data = json.load(open(path, encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        return None, f"could not read {path}: {err}"
    if not isinstance(data, dict) or "params" not in data:
        # Don't let two files that both omit 'params' silently pass the equality
        # check as "consistent" -- each must declare its params block.
        return None, f"{path}: missing top-level 'params' object"
    return data["params"], None


def check_consistency() -> List[LintMessage]:
    messages: List[LintMessage] = []

    sig_block, sig_err = extract_shared_block(SIGNIFICANT_SQL)
    wk_block, wk_err = extract_shared_block(WEEKLY_SQL)
    if sig_err:
        messages.append(_error(SIGNIFICANT_SQL, "shared-block-markers", sig_err))
    if wk_err:
        messages.append(_error(WEEKLY_SQL, "shared-block-markers", wk_err))
    if sig_block is not None and wk_block is not None and sig_block != wk_block:
        description = (
            "The shared recovery-detection / causal-attribution block (between the "
            "@autorevert-shared-recovery-pipeline markers) has DRIFTED between "
            f"{SIGNIFICANT_SQL} and {WEEKLY_SQL}. The two blocks must stay "
            "byte-identical so a fix to the shared pipeline cannot land in one query "
            "but not the other (this is exactly how the #8176 causal red-streak "
            "filter previously left the weekly chart stale). Copy the corrected block "
            "verbatim into BOTH files."
        )
        messages.append(_error(SIGNIFICANT_SQL, "shared-block-drift", description))
        messages.append(_error(WEEKLY_SQL, "shared-block-drift", description))

    sig_params, sig_perr = read_params(SIGNIFICANT_PARAMS)
    wk_params, wk_perr = read_params(WEEKLY_PARAMS)
    if sig_perr:
        messages.append(_error(SIGNIFICANT_PARAMS, "params-read", sig_perr))
    if wk_perr:
        messages.append(_error(WEEKLY_PARAMS, "params-read", wk_perr))
    if sig_params is not None and wk_params is not None and sig_params != wk_params:
        description = (
            f"'params' differ between {SIGNIFICANT_PARAMS} and {WEEKLY_PARAMS}. The "
            "two queries share a parameterized pipeline and must accept the same "
            f"parameters. significant={sig_params} weekly={wk_params}"
        )
        messages.append(_error(SIGNIFICANT_PARAMS, "params-drift", description))
        messages.append(_error(WEEKLY_PARAMS, "params-drift", description))

    return messages


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Keep the shared autorevert recovery-detection CTE block in sync.",
        fromfile_prefix_chars="@",
    )
    # lintrunner passes the changed files here; the check ignores them and always
    # compares the two canonical query files, so editing either one triggers it.
    parser.add_argument("filenames", nargs="*", help="paths to lint (informational)")
    parser.parse_args()

    try:
        for message in check_consistency():
            print(json.dumps(message._asdict()), flush=True)
    except Exception:
        logging.critical("autorevert_shared_cte_linter failed")
        raise


if __name__ == "__main__":
    main()
