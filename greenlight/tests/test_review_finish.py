from __future__ import annotations

import contextlib
import logging
import threading
from datetime import datetime, timedelta
from typing import Any, NoReturn

import pytest
from github import GithubException

from greenlight import merge_authz, quota, review_finish, verdict_labels
from greenlight.authority import Authority
from greenlight.latch import RateLimitLatch, SharedLatch
from greenlight.repo_config import BUILTIN_PYTORCH, RepoEntry
from greenlight.review_finish import PreparedScan
from greenlight.scan_memory import ScanMemory
from greenlight.state import PRState
from greenlight.state_store import InProcessStore

_NOW = datetime(2026, 11, 16, 12, 0, 0)
_HASH = "a" * 64
_VISION = RepoEntry("pytorch/vision", "greenlight", "gate", "merge_rules", "active")
_RULES = (merge_authz.compile_rule("all", ["*"], frozenset({"alice"})),)


def _unreachable(*_args: object, **_kwargs: object) -> NoReturn:
    raise AssertionError("optional work ran")


def prepared_scan(**overrides: Any) -> PreparedScan:
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
    review_finish.finish(prepared_scan(), optional=False)


@pytest.mark.parametrize(
    ("full_tick", "rate_limited", "pr", "marked"),
    [
        pytest.param(True, False, None, True, id="clean-full-tick"),
        pytest.param(True, True, None, False, id="rate-limited"),
        pytest.param(False, False, None, False, id="fast-tick"),
        pytest.param(True, False, 5, False, id="recheck"),
    ],
)
def test_a_safety_only_full_tick_counts_as_the_last_full_tick_unless_rate_limited(full_tick, rate_limited, pr, marked):
    memory = ScanMemory()
    cancel_event = threading.Event()
    if rate_limited:
        cancel_event.set()

    review_finish.finish(
        prepared_scan(memory=memory, full_tick=full_tick, cancel_event=cancel_event, pr=pr), optional=False
    )

    assert memory.full_tick_due(_NOW + timedelta(minutes=1)) is not marked


def test_a_safety_only_full_tick_is_marked_even_when_its_safety_work_failed_on_a_pr():
    memory = ScanMemory()

    with pytest.raises(RuntimeError):
        review_finish.finish(prepared_scan(memory=memory, failed=[3]), optional=False)

    assert not memory.full_tick_due(_NOW + timedelta(minutes=1))


def test_without_optional_work_the_safety_works_failures_still_raise():
    with pytest.raises(RuntimeError, match=r"^2 PR\(s\) failed during scan: \[3, 7\]$"):
        review_finish.finish(prepared_scan(failed=[7, 3, 7]), optional=False)


def test_without_optional_work_the_optional_works_failures_never_raise():
    review_finish.finish(prepared_scan(optional_failed=[5]), optional=False)


def test_the_optional_works_failures_are_kept_apart_and_raised_with_the_safety_works():
    def fingerprint(_client, _repo, number, _authorized, _skip):
        raise RuntimeError(f"fingerprint {number} down")

    prepared = prepared_scan(
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

    prepared = prepared_scan(
        entry=_VISION,
        build_github=lambda _token, **_kwargs: object(),
        fingerprint=fingerprint,
        dispatch=dispatch,
        emit_dispatched=emit,
        poke=lambda _number: None,
        label_prs=label_prs,
    )
    with prepared.stack:
        review_finish.finish(prepared)

    assert seen == {
        "fingerprint": ("pytorch/vision", 1),
        "dispatch": ("pytorch/vision", 1, False),
        "emit": ("pytorch/vision", 1),
        "labels": "pytorch/vision",
    }


def test_errors_name_failed_dispatch_failed_and_abandoned_prs_once_each():
    def dispatch(*_args, **_kwargs):
        raise RuntimeError("dispatch down")

    prepared = prepared_scan(
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
    return prepared_scan(**fields), dispatched


def test_finish_dispatches_under_a_cap_set_after_prepare():
    prepared, dispatched = _dispatching()
    prepared.max_dispatches = 2

    with prepared.stack:
        review_finish.finish(prepared)

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
        review_finish.finish(prepared)

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


def test_fingerprint_results_already_stored_survive_a_stop_that_ends_the_fan_out():
    def fingerprint(_client, _repo, number, _authorized, _skip):
        if number == 2:
            raise quota.RepoBudgetExceeded("pytorch/pytorch: past its deadline")
        return ("h" * 40, _HASH)

    memory = ScanMemory()
    quiet = _NOW - timedelta(minutes=10)
    prepared, dispatched = _dispatching(
        fingerprint=fingerprint,
        memory=memory,
        fingerprint_numbers=[1, 2],
        updated_at_by_number=dict.fromkeys((1, 2), quiet),
        states={
            1: PRState(pr_number=1, status="LAND", eval_hash=_HASH, head_sha="h" * 40, version=_NOW, run_id=1),
        },
    )

    with pytest.raises(quota.RepoBudgetExceeded), prepared.stack:
        review_finish.finish(prepared)

    assert set(memory._fingerprints) == {1}
    assert dispatched == []
    assert memory.full_tick_due(_NOW + timedelta(minutes=1))


def test_a_shared_latch_set_meanwhile_is_read_before_the_dispatch_and_holds_it_back():
    store = InProcessStore()
    shared = SharedLatch(store, lambda: 1000.0)
    prepared, dispatched = _dispatching(cancel_event=RateLimitLatch(lambda: 1000.0, shared), memory=ScanMemory())
    store.extend_latch(1300.0, 1000.0)

    with prepared.stack:
        review_finish.finish(prepared)

    assert dispatched == []
    assert prepared.cancel_event.is_set()
    assert prepared.memory is not None
    assert prepared.memory.full_tick_due(_NOW + timedelta(minutes=1))


def test_a_rate_limit_on_a_dispatch_through_finish_latches_until_the_wait_github_asked_for():
    def dispatch(_client, number, _head, _hash, _ref, *, shadow, repo):
        raise GithubException(403, {"message": "You have exceeded a secondary rate limit"}, {"retry-after": "300"})

    latch = RateLimitLatch(lambda: 1000.0)
    prepared, _dispatched = _dispatching(dispatch=dispatch, cancel_event=latch)

    with pytest.raises(RuntimeError, match=r"failed to dispatch 1 PR\(s\)"), prepared.stack:
        review_finish.finish(prepared)

    assert latch.until == 1300.0


@pytest.mark.parametrize(("marks", "marked"), [(True, True), (False, False)])
def test_a_safety_only_finish_marks_the_full_tick_only_when_the_caller_says_its_optional_work_did_not_stop(
    marks, marked
):
    memory = ScanMemory()

    review_finish.finish(prepared_scan(memory=memory), optional=False, marks_full_tick=marks)

    assert memory.full_tick_due(_NOW + timedelta(minutes=1)) is not marked


def test_a_dispatch_without_a_dispatch_token_fails_loudly():
    prepared, dispatched = _dispatching(dispatch_token=None)

    with pytest.raises(ValueError, match="there is no dispatch token"), prepared.stack:
        review_finish.finish(prepared)

    assert dispatched == []
