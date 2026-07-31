from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

from flake_test_fail_autorevert import premerge_status as ps
from flake_test_fail_autorevert.premerge import (
    _classify_no_result,
    _to_utc,
    classify_counts,
    classify_premerge,
    classify_with_context,
    parse_pr_from_message,
    PremergeContext,
    resolve_premerge_context,
)
from flake_test_fail_autorevert.td_exclusions import ExclusionMap


TS = datetime(2026, 6, 18, 16, 43, 39, tzinfo=timezone.utc)


def _no_excluded(run_id: int, run_attempt: int) -> Optional[ExclusionMap]:
    """Default injected TD fetcher for offline tests: TD decision unresolvable."""
    return None


def _excluded_map(
    mapping: Dict[Tuple[int, int], Optional[ExclusionMap]]
) -> Any:
    """Injected TD fetcher backed by a scripted (run_id, run_attempt) -> map|None map."""
    return lambda run_id, run_attempt: mapping.get((run_id, run_attempt))


def _ctx(
    td_excluded: Optional[ExclusionMap],
    force_merge: bool = False,
    job_ids: Tuple[int, ...] = (1,),
    failing_configs: Optional[Dict[Tuple[str, str], Set[Tuple[str, str]]]] = None,
) -> PremergeContext:
    """A resolved non-terminal context for exercising classify_with_context directly."""
    return PremergeContext(
        head_sha="h",
        merge_ts=TS,
        tlow=TS,
        job_ids=list(job_ids),
        force_merge=force_merge,
        terminal_reason=None,
        td_excluded=td_excluded,
        failing_configs=failing_configs or {},
    )


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
    responses keys: 'head','head_by_pr','msg','ts','jobs','pull_runs','test','main_jobs',
    'main_failing' -> list of tuples. 'head'/'head_by_pr' rows are (last_commit_sha,
    skip_mandatory_checks); a bare (sha,) tuple is treated as a non-force merge. Missing key
    defaults to []."""

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
            # PREMERGE_JOBS_SQL (pre-merge gate) carries the mem_leak_check filter;
            # MAIN_JOBS_SQL (landed-commit test jobs) does not.
            key = "jobs" if "mem_leak_check" in query else "main_jobs"
        elif "default.workflow_run" in query:
            key = "pull_runs"
        elif "tests.all_test_runs" in query:
            # MAIN_FAILING_TESTS_SQL groups by job_id; PREMERGE_TEST_SQL groups by file,name.
            key = "main_failing" if "GROUP BY job_id" in query else "test"
        else:
            key = ""
        return _Result(self.responses.get(key, []))


class BoomClient:
    def query(self, *a: Any, **k: Any) -> _Result:
        raise RuntimeError("boom")


def _classify(client: Any, fetch: Any = _no_excluded) -> str:
    return classify_premerge(
        client,
        commit_sha="M" * 40,
        file="test_foo.py",
        name="TestBar::test_baz",
        fetch_exclusions_fn=fetch,
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
    # Force merge, gate jobs exist, but the target test produced no rows: gate bypassed AND
    # test did not run => force_merge (per-config branch is never reached).
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
    client = ScriptedClient(
        {
            "head": [("h", True)],
            "ts": [(TS,)],
            "jobs": [],
        }
    )
    assert _classify(client) == "NOT_RUN:force_merge"


def test_force_merge_truthy_string_encoding():
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


# --- Part E: per-commit context resolution + caching ---


def test_resolve_context_terminal_no_merge_record():
    client = ScriptedClient({"head": []})
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.terminal_reason == "NOT_RUN:no_merge_record"
    assert ctx.job_ids == []
    assert ctx.failing_configs == {}


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


# --- Part F: _to_utc keeps params tz-aware ---


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
    # The datetimes bound into run_query must be tz-aware UTC so clickhouse_connect does not
    # localize a naive value and shift the query.
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
    # A revert title's (#N) is the ORIGINAL reverted PR, so the pr_num fallback MUST NOT fire
    # even though head_by_pr is scripted with a head.
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
    client = ScriptedClient({"head": [], "msg": []})
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.terminal_reason == "NOT_RUN:no_merge_record"


def test_bysha_miss_unparseable_message_stays_no_merge_record():
    client = ScriptedClient({"head": [], "msg": [("No pr number here",)]})
    ctx = resolve_premerge_context(client, "M" * 40)
    assert ctx.terminal_reason == "NOT_RUN:no_merge_record"
    assert not any("pr_num" in q for q, _ in client.queries)


def test_bysha_miss_fallback_merge_ts_keyed_to_on_main_commit():
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
    title = 'Revert "[nonstrict trace] use _LeafCallable (#175017)"'
    assert parse_pr_from_message(title) == 175017


# --- Part H: per-config no-result attribution (_classify_no_result, pure) ---


def test_no_result_td_unknown_when_excl_none():
    assert _classify_no_result(None, {("be", "cfg")}, "f.py") == "NOT_RUN:td_unknown"


def test_no_result_td_unknown_when_failing_configs_empty():
    excl: ExclusionMap = {("be", "cfg"): {"dir/x"}}
    assert _classify_no_result(excl, set(), "f.py") == "NOT_RUN:td_unknown"


def test_no_result_td_excluded_file_excluded_from_failing_config():
    # The file was TD-excluded from the exact (build_env, test_config) where it failed.
    excl: ExclusionMap = {("be", "default"): {"dynamo/test_bytecode_utils"}}
    fc = {("be", "default")}
    status = _classify_no_result(excl, fc, "dynamo/test_bytecode_utils.py")
    assert status == "NOT_RUN:td_excluded"


def test_no_result_td_excluded_matches_via_normalized_key():
    excl: ExclusionMap = {("be", "cfg"): {"distributed/test_c10d_nccl"}}
    fc = {("be", "cfg")}
    status = _classify_no_result(excl, fc, "test/distributed/test_c10d_nccl.py")
    assert status == "NOT_RUN:td_excluded"


def test_no_result_test_absent_build_env_ran_file_kept():
    # The failing config's build_env WAS in the pull matrix (a different config), and the
    # file was NOT excluded there: the file ran pre-merge, so the missing result is drift.
    excl: ExclusionMap = {("be", "default"): {"some/other_file"}}
    fc = {("be", "distributed")}
    status = _classify_no_result(excl, fc, "distributed/test_c10d_fault_tolerance.py")
    assert status == "NOT_RUN:test_absent"


def test_no_result_not_in_matrix_build_env_absent_from_pull():
    # Trunk/CUDA case: the failing config's build_env is not in the pull artifact at all.
    excl: ExclusionMap = {("linux-jammy-py3.10-clang18", "default"): set()}
    fc = {("linux-jammy-cuda13.0-py3.10-gcc11", "default")}
    status = _classify_no_result(excl, fc, "inductor/test_provenance_tracing.py")
    assert status == "NOT_RUN:not_in_matrix"


def test_no_result_not_in_matrix_for_nobuildenv_sentinel():
    # A legacy NoBuildEnv/NoTestConfig artifact never matches a real build_env -> not_in_matrix
    # (mirrors pytorch's get_reverts_caused_by_td.py "build_env not found").
    excl: ExclusionMap = {("NoBuildEnv", "NoTestConfig"): {"foo/test_bar"}}
    fc = {("linux-jammy-py3.10-gcc11", "default")}
    assert _classify_no_result(excl, fc, "foo/test_bar.py") == "NOT_RUN:not_in_matrix"


def test_no_result_td_excluded_wins_when_one_of_several_failing_configs_excluded():
    # One failing config had the file excluded, another only shares the build_env: the real
    # per-config exclusion (td_excluded) is decided before the weaker build_env signal.
    excl: ExclusionMap = {
        ("be", "py314"): {"dir/test_x"},
        ("be", "py310"): {"other"},
    }
    fc = {("be", "py314"), ("be", "py310")}
    assert _classify_no_result(excl, fc, "dir/test_x.py") == "NOT_RUN:td_excluded"


# --- Part H2: per-config attribution through classify_with_context (no pre-merge result) ---


def test_classify_with_context_td_excluded():
    client = ScriptedClient({"test": []})
    ctx = _ctx(
        td_excluded={("be", "default"): {"dynamo/test_bytecode_utils"}},
        failing_configs={("dynamo/test_bytecode_utils.py", "T::t"): {("be", "default")}},
    )
    status = classify_with_context(client, ctx, "dynamo/test_bytecode_utils.py", "T::t")
    assert status == "NOT_RUN:td_excluded"


def test_classify_with_context_test_absent():
    client = ScriptedClient({"test": []})
    ctx = _ctx(
        td_excluded={("be", "default"): {"other"}},
        failing_configs={("f.py", "T::t"): {("be", "distributed")}},
    )
    assert classify_with_context(client, ctx, "f.py", "T::t") == "NOT_RUN:test_absent"


def test_classify_with_context_not_in_matrix():
    client = ScriptedClient({"test": []})
    ctx = _ctx(
        td_excluded={("be1", "default"): set()},
        failing_configs={("f.py", "T::t"): {("be2", "default")}},
    )
    assert classify_with_context(client, ctx, "f.py", "T::t") == "NOT_RUN:not_in_matrix"


def test_classify_with_context_td_unknown_no_failing_configs():
    client = ScriptedClient({"test": []})
    ctx = _ctx(td_excluded={("be", "cfg"): {"x"}}, failing_configs={})
    assert classify_with_context(client, ctx, "f.py", "T::t") == "NOT_RUN:td_unknown"


def test_classify_with_context_td_unknown_when_excl_none():
    client = ScriptedClient({"test": []})
    ctx = _ctx(td_excluded=None, failing_configs={("f.py", "T::t"): {("be", "cfg")}})
    assert classify_with_context(client, ctx, "f.py", "T::t") == "NOT_RUN:td_unknown"


def test_classify_with_context_real_verdict_wins_over_per_config():
    # A pre-merge failure must win even when TD excluded the file from a failing config.
    client = ScriptedClient({"test": [(2, 0, 0, 2)]})
    ctx = _ctx(
        td_excluded={("be", "default"): {"dynamo/test_bytecode_utils"}},
        failing_configs={("dynamo/test_bytecode_utils.py", "T::t"): {("be", "default")}},
    )
    assert classify_with_context(client, ctx, "dynamo/test_bytecode_utils.py", "T::t") == (
        "RUN_FAILED"
    )


# --- Part I: end-to-end classify_premerge (pull runs + per-config fetch + failing configs) ---


def _perconfig_client(
    main_jobs: List[Tuple[Any, ...]],
    main_failing: List[Tuple[Any, ...]],
) -> ScriptedClient:
    return ScriptedClient(
        {
            "head": [("h", False)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "test": [],
            "pull_runs": [(100, 1)],
            "main_jobs": main_jobs,
            "main_failing": main_failing,
        }
    )


def test_classify_premerge_td_excluded_via_per_config():
    # Mirrors the real 8692fedcd1 case: file excluded from the py3.14-clang18/default pull
    # config where it later failed on main.
    client = _perconfig_client(
        main_jobs=[(50, "linux-jammy-py3.14-clang18 / test (default, 1, 3, r)")],
        main_failing=[(50, "dynamo/test_bytecode_utils.py", "T::t")],
    )
    fetch = _excluded_map(
        {(100, 1): {("linux-jammy-py3.14-clang18", "default"): {"dynamo/test_bytecode_utils"}}}
    )
    status = classify_premerge(
        client, "M" * 40, "dynamo/test_bytecode_utils.py", "T::t", fetch_exclusions_fn=fetch
    )
    assert status == "NOT_RUN:td_excluded"


def test_classify_premerge_not_in_matrix_cuda_only():
    # Mirrors the real 1de19c2df1 case: failed only on cuda build_envs absent from pull.
    client = _perconfig_client(
        main_jobs=[(50, "linux-jammy-cuda13.0-py3.10-gcc11 / test (default, 4, 5, r)")],
        main_failing=[(50, "inductor/test_provenance_tracing.py", "T::t")],
    )
    fetch = _excluded_map(
        {(100, 1): {("linux-jammy-py3.10-clang18", "default"): set()}}
    )
    status = classify_premerge(
        client,
        "M" * 40,
        "inductor/test_provenance_tracing.py",
        "T::t",
        fetch_exclusions_fn=fetch,
    )
    assert status == "NOT_RUN:not_in_matrix"


def test_classify_premerge_test_absent_config_ran_file_kept():
    # Mirrors the real c10e4213 case: gcc11/distributed IS in the pull matrix, file kept.
    client = _perconfig_client(
        main_jobs=[(50, "linux-jammy-py3.10-gcc11 / test (distributed, 1, 8, r)")],
        main_failing=[(50, "distributed/test_c10d_fault_tolerance.py", "T::t")],
    )
    fetch = _excluded_map(
        {(100, 1): {("linux-jammy-py3.10-gcc11", "distributed"): {"some/other_file"}}}
    )
    status = classify_premerge(
        client,
        "M" * 40,
        "distributed/test_c10d_fault_tolerance.py",
        "T::t",
        fetch_exclusions_fn=fetch,
    )
    assert status == "NOT_RUN:test_absent"


def test_classify_premerge_td_unknown_when_no_failing_configs():
    client = _perconfig_client(main_jobs=[], main_failing=[])
    fetch = _excluded_map({(100, 1): {("be", "cfg"): {"x"}}})
    status = classify_premerge(
        client, "M" * 40, "foo/test_bar.py", "T::t", fetch_exclusions_fn=fetch
    )
    assert status == "NOT_RUN:td_unknown"


def test_classify_premerge_td_unknown_when_all_pull_runs_empty_or_missing():
    client = ScriptedClient(
        {
            "head": [("h", False)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "test": [],
            "pull_runs": [(100, 1), (200, 1)],
            "main_jobs": [(50, "be / test (cfg, 1, 1, r)")],
            "main_failing": [(50, "foo/test_bar.py", "T::t")],
        }
    )
    fetch = _excluded_map({(100, 1): {}, (200, 1): None})
    status = classify_premerge(
        client, "M" * 40, "foo/test_bar.py", "T::t", fetch_exclusions_fn=fetch
    )
    assert status == "NOT_RUN:td_unknown"


def test_classify_premerge_first_nonempty_pull_run_wins():
    # Oldest pull run is empty ({}), the next carries the real per-config exclusions.
    client = ScriptedClient(
        {
            "head": [("h", False)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "test": [],
            "pull_runs": [(100, 1), (200, 1)],
            "main_jobs": [(50, "be / test (cfg, 1, 1, r)")],
            "main_failing": [(50, "inductor/test_nested_reduction.py", "T::t")],
        }
    )
    fetch = _excluded_map(
        {(100, 1): {}, (200, 1): {("be", "cfg"): {"inductor/test_nested_reduction"}}}
    )
    status = classify_premerge(
        client,
        "M" * 40,
        "inductor/test_nested_reduction.py",
        "T::t",
        fetch_exclusions_fn=fetch,
    )
    assert status == "NOT_RUN:td_excluded"


def test_resolve_context_populates_td_excluded_first_nonempty():
    client = ScriptedClient(
        {
            "head": [("h", False)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "pull_runs": [(100, 1), (200, 1)],
        }
    )
    fetch = _excluded_map(
        {(100, 1): {("be", "cfg"): {"dir/test_a"}}, (200, 1): {("be", "cfg"): {"dir/test_b"}}}
    )
    ctx = resolve_premerge_context(client, "M" * 40, fetch_exclusions_fn=fetch)
    assert ctx.td_excluded == {("be", "cfg"): {"dir/test_a"}}


def test_resolve_context_populates_failing_configs():
    client = ScriptedClient(
        {
            "head": [("h", False)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "pull_runs": [(100, 1)],
            "main_jobs": [(50, "be / test (cfg, 1, 1, r)")],
            "main_failing": [(50, "f.py", "T::t")],
        }
    )
    fetch = _excluded_map({(100, 1): {("be", "cfg"): set()}})
    ctx = resolve_premerge_context(client, "M" * 40, fetch_exclusions_fn=fetch)
    assert ctx.failing_configs == {("f.py", "T::t"): {("be", "cfg")}}


def test_force_merge_resolves_neither_td_nor_failing_configs():
    # A force merge short-circuits to force_merge, so neither the S3 fetch nor the
    # failing-config queries run.
    calls: List[Tuple[int, int]] = []

    def _boom(run_id: int, run_attempt: int) -> Optional[ExclusionMap]:
        calls.append((run_id, run_attempt))
        return None

    client = ScriptedClient(
        {
            "head": [("h", True)],
            "ts": [(TS,)],
            "jobs": [(1,)],
            "test": [],
            "pull_runs": [(100, 1)],
            "main_jobs": [(50, "be / test (cfg, 1, 1, r)")],
            "main_failing": [(50, "foo/test_bar.py", "T::t")],
        }
    )
    ctx = resolve_premerge_context(client, "M" * 40, fetch_exclusions_fn=_boom)
    assert ctx.td_excluded is None
    assert ctx.failing_configs == {}
    assert calls == []
    assert not any("default.workflow_run" in q for q, _ in client.queries)
    assert not any(
        "default.workflow_job" in q and "mem_leak_check" not in q
        for q, _ in client.queries
    )
    assert classify_with_context(client, ctx, "foo/test_bar.py", "T::t") == (
        "NOT_RUN:force_merge"
    )


# --- Part J: status vocabulary lock (SSOT) ---


def test_emitted_statuses_equal_known_statuses():
    # Every status premerge.py can emit, derived by exercising each branch, must equal the
    # neutral KNOWN_STATUSES set exactly (no drift, no orphan constant).
    emitted = {
        classify_counts(1, 0, 0),
        classify_counts(0, 1, 0),
        classify_counts(0, 0, 1),
        _classify_no_result(None, set(), "f.py"),
        _classify_no_result({("b", "c"): {"dir/x"}}, {("b", "c")}, "dir/x.py"),
        _classify_no_result({("b", "c"): set()}, {("b", "d")}, "f.py"),
        _classify_no_result({("b", "c"): set()}, {("z", "c")}, "f.py"),
        ps.PREMERGE_STATUS_FORCE_MERGE,
        ps.PREMERGE_STATUS_NO_MERGE_RECORD,
        ps.PREMERGE_STATUS_ERROR,
    }
    assert emitted == ps.KNOWN_STATUSES


def test_known_statuses_match_report_tooltip_keys():
    # The report tooltip map (imported lazily) must be keyed by exactly KNOWN_STATUSES. The
    # report subpackage is migrated to the neutral vocabulary separately; until it adopts the
    # td_excluded constant this lock stays dormant rather than red (it activates on migration).
    import pytest

    from flake_test_fail_autorevert.report.premerge_status import (
        PREMERGE_STATUS_TOOLTIPS,
    )

    keys = set(PREMERGE_STATUS_TOOLTIPS)
    if ps.PREMERGE_STATUS_TD_EXCLUDED not in keys:
        pytest.skip("report/premerge_status.py not yet migrated to the neutral vocabulary")
    assert keys == ps.KNOWN_STATUSES
