from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from flake_test_fail_autorevert.premerge import (
    _to_utc,
    classify_counts,
    classify_premerge,
    parse_pr_from_message,
    resolve_premerge_context,
)

TS = datetime(2026, 6, 18, 16, 43, 39, tzinfo=timezone.utc)


# --- Part A: parse_pr_from_message ---


def test_parse_pr_simple():
    assert parse_pr_from_message("Title (#186997)") == 186997


def test_parse_pr_multiple_on_title_takes_last():
    assert parse_pr_from_message("Foo (#1) bar (#2)") == 2


def test_parse_pr_title_only_ignores_body():
    assert parse_pr_from_message("Title (#123)\n\nbody mentions (#456)") == 123


def test_parse_pr_no_match_returns_none():
    assert parse_pr_from_message("No number here") is None


def test_parse_pr_empty_returns_none():
    assert parse_pr_from_message("") is None


def test_parse_pr_ghstack_style():
    message = (
        "Support out-of-order ranks in dist.split_group (#189090)\n\n"
        "...new_group already gained this ability via sort_ranks=False "
        "(#176580) but..."
    )
    assert parse_pr_from_message(message) == 189090


# --- Part B: classify_counts (pure) ---


def test_classify_counts_failure_wins_over_success():
    assert classify_counts(3, 5, 0) == "RUN_FAILED"


def test_classify_counts_success():
    assert classify_counts(0, 2, 0) == "RUN_SUCCEEDED"


def test_classify_counts_success_wins_over_skip():
    assert classify_counts(0, 1, 3) == "RUN_SUCCEEDED"


def test_classify_counts_skipped_only():
    assert classify_counts(0, 0, 4) == "NOT_RUN:skipped"


def test_classify_counts_all_zero_returns_none():
    assert classify_counts(0, 0, 0) is None


# --- Part C: classify_premerge (scripted IO) ---


class _Result:
    def __init__(self, rows: List[Tuple[Any, ...]]) -> None:
        self.result_rows = rows


class ScriptedClient:
    """Returns canned result_rows keyed by which premerge SQL is executing.
    responses: dict with keys 'head','ts','jobs','test','file' -> list of tuples.
    The 'head' rows are (last_commit_sha, skip_mandatory_checks) tuples; a bare
    (sha,) tuple is treated as a non-force merge. Missing key defaults to []."""

    def __init__(self, responses: Dict[str, List[Tuple[Any, ...]]]) -> None:
        self.responses = dict(responses)
        head = self.responses.get("head")
        if head:
            self.responses["head"] = [
                row if len(row) >= 2 else (row[0], False) for row in head
            ]
        self.queries: List[Tuple[str, Optional[Dict[str, Any]]]] = []

    def query(self, query: str, parameters: Optional[Dict[str, Any]] = None) -> _Result:
        self.queries.append((query, parameters))
        if "default.merges" in query:
            key = "head"
        elif "ARRAY JOIN commits" in query:
            key = "ts"
        elif "default.workflow_job" in query:
            key = "jobs"
        elif "failure_count + error_count" in query:
            key = "test"
        else:
            key = "file"
        return _Result(self.responses.get(key, []))


class BoomClient:
    def query(self, *a: Any, **k: Any) -> _Result:
        raise RuntimeError("boom")


def _classify(client: Any) -> str:
    return classify_premerge(
        client,
        commit_sha="M" * 40,
        file="test_foo.py",
        name="TestBar::test_baz",
    )


def test_no_merge_record_when_no_merges_row():
    # No merges row => we cannot resolve a pre-merge head (ghstack non-tip / revert /
    # direct push / old data). Honest label is no_merge_record, NOT force_merge.
    client = ScriptedClient({"head": []})
    assert _classify(client) == "NOT_RUN:no_merge_record"


def test_run_failed():
    client = ScriptedClient(
        {
            "head": [("abc123head", False)],
            "ts": [(TS,)],
            "jobs": [(111,), (222,)],
            "test": [(3, 1, 0, 4)],
        }
    )
    assert _classify(client) == "RUN_FAILED"


def test_run_succeeded():
    client = ScriptedClient(
        {
            "head": [("h", False)],
            "ts": [(TS,)],
            "jobs": [(111,)],
            "test": [(0, 2, 0, 2)],
        }
    )
    assert _classify(client) == "RUN_SUCCEEDED"


def test_skipped_only():
    client = ScriptedClient(
        {
            "head": [("h", False)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "test": [(0, 0, 3, 3)],
        }
    )
    assert _classify(client) == "NOT_RUN:skipped"


def test_td_deselected_when_test_absent_but_file_present():
    client = ScriptedClient(
        {
            "head": [("h", False)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "test": [],
            "file": [(76,)],
        }
    )
    assert _classify(client) == "NOT_RUN:td_deselected"


def test_not_in_matrix_when_file_absent():
    client = ScriptedClient(
        {
            "head": [("h", False)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "test": [],
            "file": [(0,)],
        }
    )
    assert _classify(client) == "NOT_RUN:not_in_matrix"


def test_not_in_matrix_when_no_jobs():
    client = ScriptedClient(
        {
            "head": [("h", False)],
            "ts": [(TS,)],
            "jobs": [],
        }
    )
    assert _classify(client) == "NOT_RUN:not_in_matrix"


def test_error_when_ts_missing():
    client = ScriptedClient({"head": [("h", False)], "ts": []})
    assert _classify(client) == "ERROR"


def test_error_when_ts_epoch():
    client = ScriptedClient(
        {
            "head": [("h", False)],
            "ts": [(datetime(1970, 1, 1, tzinfo=timezone.utc),)],
        }
    )
    assert _classify(client) == "ERROR"


def test_error_on_query_exception():
    assert _classify(BoomClient()) == "ERROR"


def test_empty_result_never_succeeded():
    # Invariant: an empty/partial read can never be reported as a pass.
    client = ScriptedClient(
        {
            "head": [("h", False)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "test": [],
            "file": [(0,)],
        }
    )
    result = _classify(client)
    assert result != "RUN_SUCCEEDED"
    assert result.startswith("NOT_RUN")


def test_failure_before_success_via_io():
    client = ScriptedClient(
        {
            "head": [("h", False)],
            "ts": [(TS,)],
            "jobs": [(1, 2)],
            "test": [(5, 10, 0, 15)],
        }
    )
    assert _classify(client) == "RUN_FAILED"


# --- Part D: real force-merge semantics (skip_mandatory_checks truthy) ---


def test_force_merge_does_not_mask_real_failure():
    # A REAL force merge (skip_mandatory_checks truthy) that STILL ran partial CI: the
    # real RUN_FAILED verdict must win — force_merge never masks a real outcome.
    client = ScriptedClient(
        {
            "head": [("h", True)],
            "ts": [(TS,)],
            "jobs": [(111,), (222,)],
            "test": [(2, 0, 0, 2)],
        }
    )
    assert _classify(client) == "RUN_FAILED"


def test_force_merge_does_not_mask_real_success():
    client = ScriptedClient(
        {
            "head": [("h", True)],
            "ts": [(TS,)],
            "jobs": [(111,)],
            "test": [(0, 3, 0, 3)],
        }
    )
    assert _classify(client) == "RUN_SUCCEEDED"


def test_force_merge_when_test_did_not_run_with_jobs():
    # Force merge, gate jobs exist, but the target test produced no rows at all: the gate
    # was bypassed AND the test did not run => force_merge (no file probe needed).
    client = ScriptedClient(
        {
            "head": [("h", True)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "test": [],
        }
    )
    assert _classify(client) == "NOT_RUN:force_merge"


def test_force_merge_when_no_jobs():
    # Force merge with no gate jobs on the head at all => force_merge (gate bypassed).
    client = ScriptedClient(
        {
            "head": [("h", True)],
            "ts": [(TS,)],
            "jobs": [],
        }
    )
    assert _classify(client) == "NOT_RUN:force_merge"


def test_force_merge_truthy_string_encoding():
    # Robust truthiness: a driver/schema change returning 'true' must still count as force.
    client = ScriptedClient(
        {
            "head": [("h", "true")],
            "ts": [(TS,)],
            "jobs": [],
        }
    )
    assert _classify(client) == "NOT_RUN:force_merge"


def test_non_force_string_false_is_not_force():
    # bool('false') is True in Python; _is_force must treat the string 'false' as False.
    client = ScriptedClient(
        {
            "head": [("h", "false")],
            "ts": [(TS,)],
            "jobs": [],
        }
    )
    assert _classify(client) == "NOT_RUN:not_in_matrix"


# --- Part E: per-commit context resolution + caching (FIX C) ---


def test_resolve_context_terminal_no_merge_record():
    client = ScriptedClient({"head": []})
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.terminal_reason == "NOT_RUN:no_merge_record"
    assert ctx.job_ids == []


def test_resolve_context_populates_jobs_and_force_flag():
    client = ScriptedClient(
        {
            "head": [("h", True)],
            "ts": [(TS,)],
            "jobs": [(1,), (2,)],
        }
    )
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.terminal_reason is None
    assert ctx.job_ids == [1, 2]
    assert ctx.force_merge is True
    assert ctx.head_sha == "h"


# --- Part F: _to_utc keeps params tz-aware (FIX E) ---


class ParamSpyClient:
    """Records the parameters dict of every query so tests can assert on bound values."""

    def __init__(self, responses: Dict[str, List[Tuple[Any, ...]]]) -> None:
        self._scripted = ScriptedClient(responses)
        self.params: List[Dict[str, Any]] = []

    def query(self, query: str, parameters: Optional[Dict[str, Any]] = None) -> _Result:
        self.params.append(dict(parameters or {}))
        return self._scripted.query(query, parameters)


def test_to_utc_makes_naive_tz_aware():
    naive = datetime(2026, 6, 18, 16, 43, 39)
    out = _to_utc(naive)
    assert out.tzinfo is not None
    assert out.utcoffset() == datetime(2026, 1, 1, tzinfo=timezone.utc).utcoffset()


def test_bound_datetime_params_are_tz_aware_utc():
    # FIX E: the datetimes bound into run_query (lower/merge_ts/tlow) must be tz-aware
    # UTC, so clickhouse_connect does not localize a naive value and shift the query.
    client = ParamSpyClient(
        {
            "head": [("h", False)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "test": [(0, 1, 0, 1)],
        }
    )
    resolve_premerge_context(client, "M" * 40)
    dt_params: List[Tuple[str, datetime]] = []
    for p in client.params:
        for k, v in p.items():
            if isinstance(v, datetime):
                dt_params.append((k, v))
    assert dt_params, "expected at least one datetime param bound"
    for k, v in dt_params:
        assert v.tzinfo is not None, f"param {k} is tz-naive"
        assert v.utcoffset() == timezone.utc.utcoffset(v), f"param {k} not UTC"
