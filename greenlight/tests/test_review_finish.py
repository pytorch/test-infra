from __future__ import annotations

import contextlib
import threading
from datetime import datetime, timedelta
from typing import Any, NoReturn

import pytest

from greenlight import merge_authz, review_finish
from greenlight.authority import Authority
from greenlight.repo_config import BUILTIN_PYTORCH, RepoEntry
from greenlight.review_finish import PreparedScan

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
    review_finish.finish(_prepared(), optional=False)


def test_without_optional_work_the_safety_works_failures_still_raise():
    with pytest.raises(RuntimeError, match=r"^2 PR\(s\) failed during scan: \[3, 7\]$"):
        review_finish.finish(_prepared(failed=[7, 3, 7]), optional=False)


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
