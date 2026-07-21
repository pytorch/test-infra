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
    responses: dict with keys 'head','head_by_pr','msg','ts','jobs','test','file' ->
    list of tuples. The 'head'/'head_by_pr' rows are (last_commit_sha,
    skip_mandatory_checks) tuples; a bare (sha,) tuple is treated as a non-force merge.
    'msg' rows are (commit_message,) tuples. Missing key defaults to []."""

    def __init__(self, responses: Dict[str, List[Tuple[Any, ...]]]) -> None:
        self.responses = dict(responses)
        for head_key in ("head", "head_by_pr"):
            head = self.responses.get(head_key)
            if head:
                self.responses[head_key] = [
                    row if len(row) >= 2 else (row[0], False) for row in head
                ]
        self.queries: List[Tuple[str, Optional[Dict[str, Any]]]] = []

    def query(self, query: str, parameters: Optional[Dict[str, Any]] = None) -> _Result:
        self.queries.append((query, parameters))
        if "default.merges" in query and "pr_num" in query:
            key = "head_by_pr"
        elif "default.merges" in query:
            key = "head"
        elif "arrayFilter" in query:
            key = "msg"
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


def test_bound_datetime_params_are_tz_aware_utc() -> None:
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


# --- Part G: by-sha MISS pr_num fallback (merge_commit_sha != landed sha) ---


def test_bysha_hit_skips_pr_fallback():
    # Regression guard: when the by-sha lookup returns a head, the pr_num fallback (msg /
    # head_by_pr) is never consulted, even if scripted with a conflicting head.
    client = ScriptedClient(
        {
            "head": [("bysha_head", False)],
            "head_by_pr": [("pr_head", False)],
            "msg": [("Title (#42)",)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "test": [(0, 2, 0, 2)],
        }
    )
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.head_sha == "bysha_head"
    assert not any("pr_num" in q for q, _ in client.queries)
    assert not any("arrayFilter" in q for q, _ in client.queries)
    assert _classify(client) == "RUN_SUCCEEDED"


def test_bysha_miss_single_pr_head_resolves_and_proceeds():
    # By-sha miss + non-revert title + exactly one distinct pr_num head => recover that
    # head and run the normal downstream flow (here a scripted success).
    client = ScriptedClient(
        {
            "head": [],
            "msg": [("Support out-of-order ranks (#189090)",)],
            "head_by_pr": [("d73ded44", False)],
            "ts": [(TS,)],
            "jobs": [(111,)],
            "test": [(0, 3, 0, 3)],
        }
    )
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.terminal_reason is None
    assert ctx.head_sha == "d73ded44"
    assert _classify(client) == "RUN_SUCCEEDED"


def test_bysha_miss_pr_head_carries_force_flag():
    # The recovered head's skip_mandatory_checks must flow into force_merge so a real
    # force merge with no gate jobs still attributes to force_merge (not not_in_matrix).
    client = ScriptedClient(
        {
            "head": [],
            "msg": [("Title (#500)",)],
            "head_by_pr": [("fh", True)],
            "ts": [(TS,)],
            "jobs": [],
        }
    )
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.head_sha == "fh"
    assert ctx.force_merge is True
    assert _classify(client) == "NOT_RUN:force_merge"


def test_bysha_miss_revert_title_stays_no_merge_record():
    # MOST IMPORTANT new guard: a revert title's (#N) is the ORIGINAL reverted PR, so the
    # pr_num fallback MUST NOT fire even though head_by_pr is scripted with a head. Using
    # it would fetch the wrong PR's head and check the wrong test.
    client = ScriptedClient(
        {
            "head": [],
            "msg": [('Revert "Something bad (#175017)"',)],
            "head_by_pr": [("wrong_head", False)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "test": [(0, 5, 0, 5)],
        }
    )
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.terminal_reason == "NOT_RUN:no_merge_record"
    assert ctx.head_sha is None
    assert not any("pr_num" in q for q, _ in client.queries)
    assert _classify(client) == "NOT_RUN:no_merge_record"


def test_bysha_miss_backout_title_stays_no_merge_record():
    # 'Back out ' is the internal-import revert variant; it is a revert too, so the same
    # (#N)-is-the-original-PR reasoning excludes it from the pr_num fallback.
    client = ScriptedClient(
        {
            "head": [],
            "msg": [('Back out "D123 broke stuff (#180000)"',)],
            "head_by_pr": [("wrong_head", False)],
            "ts": [(TS,)],
        }
    )
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.terminal_reason == "NOT_RUN:no_merge_record"
    assert not any("pr_num" in q for q, _ in client.queries)


def test_bysha_miss_zero_pr_heads_stays_no_merge_record():
    # By-sha miss + non-revert + no head_by_pr rows (truly none, e.g. pr 176543) => stay
    # undetermined rather than guess.
    client = ScriptedClient(
        {
            "head": [],
            "msg": [("Some inductor change (#176543)",)],
            "head_by_pr": [],
            "ts": [(TS,)],
        }
    )
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.terminal_reason == "NOT_RUN:no_merge_record"
    assert ctx.head_sha is None


def test_bysha_miss_ambiguous_two_pr_heads_stays_no_merge_record():
    # Two DISTINCT last_commit_sha for the pr => ambiguous multi-merge; do not guess a
    # head, stay no_merge_record (safer to under-attribute than pick a wrong head).
    client = ScriptedClient(
        {
            "head": [],
            "msg": [("Title (#600)",)],
            "head_by_pr": [("head_a", False), ("head_b", False)],
            "ts": [(TS,)],
        }
    )
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.terminal_reason == "NOT_RUN:no_merge_record"
    assert ctx.head_sha is None


def test_bysha_miss_duplicate_same_pr_head_is_unambiguous():
    # Multiple rows collapsing to ONE distinct last_commit_sha (a re-merge of the same
    # head) is unambiguous and must resolve, not be treated as multi-merge.
    client = ScriptedClient(
        {
            "head": [],
            "msg": [("Title (#700)",)],
            "head_by_pr": [("same_head", False), ("same_head", False)],
            "ts": [(TS,)],
            "jobs": [(9,)],
            "test": [(1, 0, 0, 1)],
        }
    )
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.head_sha == "same_head"
    assert _classify(client) == "RUN_FAILED"


def test_bysha_miss_no_message_stays_no_merge_record():
    # By-sha miss + no push message row at all => cannot parse a PR, stay no_merge_record.
    client = ScriptedClient({"head": [], "msg": []})
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.terminal_reason == "NOT_RUN:no_merge_record"


def test_bysha_miss_unparseable_message_stays_no_merge_record():
    # By-sha miss + message with no (#N) => no PR to resolve by, stay no_merge_record.
    client = ScriptedClient({"head": [], "msg": [("No pr number here",)]})
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.terminal_reason == "NOT_RUN:no_merge_record"
    assert not any("pr_num" in q for q, _ in client.queries)


def test_bysha_miss_fallback_merge_ts_keyed_to_on_main_commit():
    # merge_ts is derived from MERGE_TS_SQL bound to the ON-MAIN commit ({commit}), NOT
    # the recovered fallback head: the landed commit's timestamp is the pre/post boundary.
    client = ScriptedClient(
        {
            "head": [],
            "msg": [("Title (#42)",)],
            "head_by_pr": [("fallback_head", False)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "test": [(0, 1, 0, 1)],
        }
    )
    resolve_premerge_context(client, "ONMAIN" + "0" * 34)
    ts_params = [
        p
        for q, p in client.queries
        if "arrayFilter" not in q and "ARRAY JOIN commits" in q
    ]
    assert ts_params, "expected MERGE_TS_SQL to run"
    for p in ts_params:
        assert p["merge_commit"] == "ONMAIN" + "0" * 34


def test_parse_pr_from_revert_title_returns_original_pr():
    # Documents WHY the revert guard is needed (not the parser): the parser correctly
    # returns the ORIGINAL PR embedded in a revert title, which is the WRONG PR to resolve
    # a pre-merge head by. The guard, not the parser, prevents the misresolution.
    title = 'Revert "[nonstrict trace] use _LeafCallable (#175017)"'
    assert parse_pr_from_message(title) == 175017
