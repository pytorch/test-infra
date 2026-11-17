from __future__ import annotations

import contextlib
import logging
import threading
from dataclasses import replace
from datetime import datetime, timedelta
from typing import Any, NoReturn

import pytest
from github import GithubException

from greenlight import merge_authz, quota, review_finish, verdict_labels
from greenlight.authority import Authority
from greenlight.change_feed import Marker
from greenlight.repo_config import BUILTIN_PYTORCH, RepoEntry
from greenlight.review_finish import PreparedScan
from greenlight.scan_memory import FingerprintCache, ScanMemory
from greenlight.state import PRState

_NOW = datetime(2026, 11, 16, 12, 0, 0)
_HASH = "a" * 64
_VISION = RepoEntry("pytorch/vision", "greenlight", "gate", "merge_rules", "active")
_RULES = (merge_authz.compile_rule("all", ["*"], frozenset({"alice"})),)


def _unreachable(*_args: object, **_kwargs: object) -> NoReturn:
    raise AssertionError("optional work ran")


def _prepared(**overrides: Any) -> PreparedScan:
    fields: dict[str, Any] = {
        "entry": BUILTIN_PYTORCH,
        "stack": contextlib.ExitStack(),
        "client": object(),
        "token": "t",
        "dispatch_token": "t",
        "build_github": _unreachable,
        "pr": None,
        "max_dispatches": None,
        "ref": "main",
        "force": False,
        "bot_login": "",
        "timeout": timedelta(minutes=45),
        "memory": None,
        "full_tick": True,
        "listed_at": _NOW,
        "evaluated_at": _NOW,
        "states": {},
        "authority": Authority(rules=_RULES, authors={1: "alice"}, recorded=()),
        "authorized_logins": frozenset({"alice"}),
        "fingerprint_numbers": [1],
        "recent": [1],
        "ineligible": [],
        "excluded": frozenset(),
        "skip_on_approval": True,
        "labels_by_number": {1: ()},
        "head_sha_by_number": {1: "h" * 40},
        "updated_at_by_number": {1: _NOW},
        "cancel_event": threading.Event(),
        "poke": _unreachable,
        "fingerprint": _unreachable,
        "dispatch": _unreachable,
        "emit_dispatched": _unreachable,
        "label_prs": _unreachable,
        "get_pr": _unreachable,
        "upsert_comment": _unreachable,
        "now": lambda: _NOW,
    }
    fields.update(overrides)
    return PreparedScan(**fields)


def test_without_optional_work_nothing_optional_runs_and_a_clean_safety_pass_returns():
    assert review_finish.finish(_prepared(), optional=False) == 0


def test_without_optional_work_the_safety_works_failures_still_raise():
    with pytest.raises(RuntimeError, match=r"^2 PR\(s\) failed during scan: \[3, 7\]$"):
        review_finish.finish(_prepared(failed=[7, 3, 7]), optional=False)


def test_without_optional_work_the_optional_works_failures_never_raise():
    assert review_finish.finish(_prepared(optional_failed=[5]), optional=False) == 0


def test_the_optional_works_failures_are_kept_apart_and_raised_with_the_safety_works():
    def fingerprint(_client, _repo, number, _authorized, _skip):
        raise RuntimeError(f"fingerprint {number} down")

    prepared = _prepared(
        build_github=lambda _token, **_kwargs: object(),
        fingerprint=fingerprint,
        poke=lambda _number: None,
        label_prs=lambda _label_pass: None,
        failed=[7],
    )
    with pytest.raises(RuntimeError, match=r"^2 PR\(s\) failed during scan: \[1, 7\]$"), prepared.stack:
        review_finish.finish(prepared)

    assert (prepared.failed, prepared.optional_failed) == ([7], [1])


def test_the_optional_work_fingerprints_dispatches_and_labels_on_the_entrys_repo():
    seen: dict[str, object] = {}

    def fingerprint(_client, repo, number, _authorized, _skip):
        seen["fingerprint"] = (repo, number)
        return ("h" * 40, _HASH)

    def dispatch(_client, number, _head, _hash, _ref, *, shadow, repo):
        seen["dispatch"] = (repo, number, shadow)

    def emit(*, repo, pr_number, **_kwargs):
        seen["emit"] = (repo, pr_number)

    def label_prs(label_pass):
        seen["labels"] = label_pass.repo

    prepared = _prepared(
        entry=_VISION,
        build_github=lambda _token, **_kwargs: object(),
        fingerprint=fingerprint,
        dispatch=dispatch,
        emit_dispatched=emit,
        poke=lambda _number: None,
        label_prs=label_prs,
    )
    with prepared.stack:
        dispatched = review_finish.finish(prepared)

    assert dispatched == 1
    assert seen == {
        "fingerprint": ("pytorch/vision", 1),
        "dispatch": ("pytorch/vision", 1, False),
        "emit": ("pytorch/vision", 1),
        "labels": "pytorch/vision",
    }


def test_errors_name_failed_dispatch_failed_and_abandoned_prs_once_each():
    def dispatch(*_args, **_kwargs):
        raise RuntimeError("dispatch down")

    prepared = _prepared(
        build_github=lambda _token, **_kwargs: object(),
        fingerprint=lambda *_args: ("h" * 40, _HASH),
        dispatch=dispatch,
        label_prs=lambda _label_pass: None,
        failed=[9],
    )
    with pytest.raises(RuntimeError) as excinfo, prepared.stack:
        review_finish.finish(prepared)

    assert str(excinfo.value) == "1 PR(s) failed during scan: [9]; failed to dispatch 1 PR(s): [1]"


class _Client:
    def __init__(self, token: str) -> None:
        self.token = token
        self.closed = 0

    def close(self) -> None:
        self.closed += 1


def _dispatching(**overrides: Any) -> tuple[PreparedScan, list[tuple[object, int]]]:
    """A prepared scan of PRs 1 to 3, all dispatchable, whose dispatch records the client and PR it got."""
    dispatched: list[tuple[object, int]] = []

    def dispatch(client, number, _head, _hash, _ref, *, shadow, repo):
        dispatched.append((client, number))

    fields: dict[str, Any] = {
        "build_github": lambda token, **_kwargs: _Client(token),
        "fingerprint": lambda *_args: ("h" * 40, _HASH),
        "dispatch": dispatch,
        "emit_dispatched": lambda **_kwargs: None,
        "poke": lambda _number: None,
        "label_prs": lambda _label_pass: None,
        "authority": Authority(rules=_RULES, authors=dict.fromkeys((1, 2, 3), "alice"), recorded=()),
        "fingerprint_numbers": [1, 2, 3],
        "recent": [1, 2, 3],
        "labels_by_number": dict.fromkeys((1, 2, 3), ()),
        "head_sha_by_number": dict.fromkeys((1, 2, 3), "h" * 40),
        "updated_at_by_number": dict.fromkeys((1, 2, 3), _NOW),
    }
    fields.update(overrides)
    return _prepared(**fields), dispatched


def test_finish_returns_how_many_reviews_it_dispatched_under_a_cap_set_after_prepare():
    prepared, dispatched = _dispatching()
    prepared.max_dispatches = 2

    with prepared.stack:
        assert review_finish.finish(prepared) == 2

    assert len(dispatched) == 2


def test_the_dispatch_uses_the_scan_client_when_the_dispatch_token_is_the_scan_token():
    scan_client = _Client("t")
    prepared, dispatched = _dispatching(client=scan_client)

    with prepared.stack:
        review_finish.finish(prepared)

    assert {client for client, _number in dispatched} == {scan_client}


def test_the_dispatch_goes_through_a_client_on_the_dispatch_token_when_it_differs():
    built: list[_Client] = []

    def build_github(token, **_kwargs):
        built.append(_Client(token))
        return built[-1]

    prepared, dispatched = _dispatching(dispatch_token="dispatch", build_github=build_github)

    with prepared.stack:
        review_finish.finish(prepared)

    [dispatch_client] = [client for client in built if client.token == "dispatch"]
    assert {client for client, _number in dispatched} == {dispatch_client}
    assert dispatch_client.closed == 1


def test_nothing_to_dispatch_builds_no_dispatch_client():
    built: list[str] = []

    def build_github(token, **_kwargs):
        built.append(token)
        return _Client(token)

    prepared, _dispatched = _dispatching(
        dispatch_token="dispatch", build_github=build_github, fingerprint=lambda *_args: ("h" * 40, _HASH)
    )
    prepared.states.update(
        {
            number: PRState(pr_number=number, status="LAND", eval_hash=_HASH, head_sha="h" * 40, version=_NOW, run_id=1)
            for number in (1, 2, 3)
        }
    )

    with prepared.stack:
        assert review_finish.finish(prepared) == 0

    assert "dispatch" not in built


def test_a_rate_limit_on_a_dispatch_sets_the_event_defers_the_rest_and_skips_the_label_pass(caplog):
    def dispatch(_client, number, _head, _hash, _ref, *, shadow, repo):
        raise GithubException(429, {"message": "secondary rate limit"})

    prepared, _dispatched = _dispatching(dispatch=dispatch, label_prs=verdict_labels.label_listed_prs)

    with caplog.at_level(logging.INFO, logger="greenlight"), pytest.raises(RuntimeError) as excinfo, prepared.stack:
        review_finish.finish(prepared)

    assert prepared.cancel_event.is_set()
    assert str(excinfo.value) == "failed to dispatch 1 PR(s): [1]"
    messages = [record.getMessage() for record in caplog.records]
    assert "deferred PR #2 dispatch: a rate limit stopped this tick's GitHub work" in messages
    assert "deferred PR #3 dispatch: a rate limit stopped this tick's GitHub work" in messages
    assert "label pass skipped: a rate limit stopped this tick's GitHub work" in messages


def test_the_dispatch_count_holds_when_finish_raises_for_a_failed_dispatch():
    def dispatch(_client, number, _head, _hash, _ref, *, shadow, repo):
        if number == 2:
            raise RuntimeError("dispatch down")

    prepared, _dispatched = _dispatching(dispatch=dispatch)

    with pytest.raises(RuntimeError, match=r"failed to dispatch 1 PR\(s\): \[2\]"), prepared.stack:
        review_finish.finish(prepared)

    assert prepared.dispatched == 2


def test_the_dispatch_count_holds_when_a_budget_stop_ends_the_dispatches():
    def dispatch(_client, number, _head, _hash, _ref, *, shadow, repo):
        if number == 2:
            raise quota.RepoBudgetExceeded("pytorch/pytorch: past its deadline")

    prepared, _dispatched = _dispatching(dispatch=dispatch)

    with pytest.raises(quota.RepoBudgetExceeded), prepared.stack:
        review_finish.finish(prepared)

    assert prepared.dispatched == 1


def test_a_dispatch_without_a_dispatch_token_fails_loudly():
    prepared, dispatched = _dispatching(dispatch_token=None)

    with pytest.raises(ValueError, match="there is no dispatch token"), prepared.stack:
        review_finish.finish(prepared)

    assert dispatched == []


def test_a_safety_only_finish_counts_nothing():
    prepared = _prepared()

    assert review_finish.finish(prepared, optional=False) == 0
    assert prepared.dispatched == 0


def _landed(number: int) -> PRState:
    return PRState(pr_number=number, status="LAND", eval_hash=_HASH, head_sha="h" * 40, version=_NOW, run_id=1)


def _built_memory() -> ScanMemory:
    memory = ScanMemory()
    memory.view.rebuild([], _NOW)
    memory.mark_full_tick(_NOW - timedelta(minutes=15))
    return memory


def test_a_wide_tick_whose_fan_out_hit_no_rate_limit_is_marked_at_its_listing_time():
    memory = _built_memory()
    prepared, _dispatched = _dispatching(memory=memory, full_tick=False, wide_tick=True)

    with prepared.stack:
        review_finish.finish(prepared)

    assert not memory.wide_due(_NOW + timedelta(minutes=14))
    assert memory.wide_due(_NOW + timedelta(minutes=15))
    assert memory.sweep_due(_NOW)


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"full_tick": False, "wide_tick": False}, id="event-tick"),
        pytest.param({"full_tick": False, "wide_tick": True, "pr": 1}, id="single-pr"),
    ],
)
def test_neither_an_event_tick_nor_a_single_pr_scan_marks_a_wide_tick(overrides):
    memory = _built_memory()
    prepared, _dispatched = _dispatching(memory=memory, **overrides)

    with prepared.stack:
        review_finish.finish(prepared)

    assert memory.wide_due(_NOW)


def test_a_wide_tick_cut_by_a_rate_limit_is_not_marked():
    memory = _built_memory()
    prepared, _dispatched = _dispatching(
        memory=memory, full_tick=False, wide_tick=True, fingerprint=_rate_limited, recent=[1], fingerprint_numbers=[1]
    )

    with pytest.raises(RuntimeError, match=r"failed during scan: \[1\]"), prepared.stack:
        review_finish.finish(prepared)

    assert prepared.cancel_event.is_set()
    assert memory.wide_due(_NOW)


def _rate_limited(*_args: object) -> NoReturn:
    raise GithubException(429, {"message": "secondary rate limit"})


def _cache_inputs(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    seen: dict[str, Any] = {}

    class Recording(FingerprintCache):
        def __init__(self, memory: ScanMemory, **kwargs: Any) -> None:
            seen.update(kwargs)
            super().__init__(memory, **kwargs)

    monkeypatch.setattr(review_finish, "FingerprintCache", Recording)
    return seen


def test_the_cache_gets_the_scans_markers_and_revalidates_its_landed_prs(monkeypatch):
    seen = _cache_inputs(monkeypatch)
    markers = {1: (Marker(reviews=1), _NOW), 2: None}
    prepared, _dispatched = _dispatching(memory=_built_memory(), full_tick=False, markers=markers)
    prepared.states.update({1: _landed(1), 3: _landed(3)})
    prepared.states[2] = replace(_landed(2), status="NO_LAND")

    with prepared.stack:
        review_finish.finish(prepared)

    assert seen["markers"] is markers
    assert seen["revalidate"] == frozenset({1, 3})


def test_a_scan_without_markers_revalidates_nothing(monkeypatch):
    seen = _cache_inputs(monkeypatch)
    prepared, _dispatched = _dispatching(memory=ScanMemory(), full_tick=False)
    prepared.states.update({1: _landed(1)})

    with prepared.stack:
        review_finish.finish(prepared)

    assert seen["markers"] == {}
    assert seen["revalidate"] == frozenset()
