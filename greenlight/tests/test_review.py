import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, cast

import pytest

from greenlight import github_client, review
from greenlight.constants import (
    DEFAULT_DISPATCH_REF,
    DEFAULT_TIMEOUT_MINUTES,
    STATUS_AI_REVIEW_STARTED,
    STATUS_CANCELLED,
    STATUS_LAND,
)
from greenlight.github_client import OpenPR
from greenlight.state import PRState

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from github import Github

    from greenlight.config import Config

# The scan client is threaded through every seam but never inspected by the fakes below,
# so a bare sentinel cast to the client type is all the loop needs.
_CLIENT = cast("Github", object())

_HASH_A = "a" * 64
_HASH_B = "b" * 64
_NOW = datetime(2026, 7, 31, 12, 0, 0)
_FRESH = _NOW - timedelta(minutes=10)
_STALE = _NOW - timedelta(minutes=40)
_OLD = _NOW - timedelta(days=2)
_NEW = _NOW - timedelta(hours=1)


def _open_pr(number: int, *, head_sha: str | None = None) -> OpenPR:
    return OpenPR(
        repo=review.TARGET_REPO,
        number=number,
        author="albanD",
        title=f"fix {number}",
        url=f"https://example.test/{number}",
        head_sha=head_sha or f"headsha{number}",
    )


def _state(number: int, status: str, eval_hash: str, version: datetime) -> PRState:
    return PRState(pr_number=number, status=status, eval_hash=eval_hash, head_sha=f"rec{number}", version=version)


@dataclass
class _Scan:
    dispatched: list[tuple[int, str, str, str]]
    read_calls: list[tuple[str, list[int]]]
    fingerprinted: list[int]
    listed_calls: int


def _run_scan(
    make_config: Callable[..., Config],
    *,
    fingerprints: dict[int, tuple[str, str]],
    listed: Sequence[OpenPR] = (),
    states: dict[int, PRState] | None = None,
    pr: int | None = None,
    max_dispatches: int | None = None,
    ref: str = DEFAULT_DISPATCH_REF,
    timeout_minutes: int = DEFAULT_TIMEOUT_MINUTES,
    now: datetime = _NOW,
) -> _Scan:
    states = states or {}
    dispatched: list[tuple[int, str, str, str]] = []
    read_calls: list[tuple[str, list[int]]] = []
    fingerprinted: list[int] = []
    listed_calls: list[int] = []

    def fake_fetch(_client):
        listed_calls.append(1)
        return list(listed)

    def fake_fingerprint(_client, number):
        fingerprinted.append(number)
        return fingerprints[number]

    def fake_read_state(repo, numbers):
        nums = list(numbers)
        read_calls.append((repo, nums))
        return {n: states[n] for n in nums if n in states}

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref):
        dispatched.append((number, head_sha, eval_hash, dispatch_ref))

    review.run(
        make_config(github_token="t"),
        pr=pr,
        max_dispatches=max_dispatches,
        ref=ref,
        timeout_minutes=timeout_minutes,
        build_github=lambda _token: _CLIENT,
        fetch=fake_fetch,
        fingerprint=fake_fingerprint,
        read_state=fake_read_state,
        dispatch=fake_dispatch,
        now=lambda: now,
    )
    return _Scan(dispatched, read_calls, fingerprinted, len(listed_calls))


def test_never_reviewed_dispatches(make_config):
    scan = _run_scan(make_config, listed=[_open_pr(1)], fingerprints={1: ("headsha1", _HASH_A)})

    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert scan.fingerprinted == [1]
    assert scan.read_calls == [(review.TARGET_REPO, [1])]


def test_decided_same_hash_skips(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _NEW)},
    )

    assert scan.dispatched == []


def test_changed_hash_dispatches(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1b", _HASH_B)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _NEW)},
    )

    assert scan.dispatched == [(1, "headsha1b", _HASH_B, DEFAULT_DISPATCH_REF)]


def test_in_flight_fresh_waits(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_AI_REVIEW_STARTED, _HASH_A, _FRESH)},
    )

    assert scan.dispatched == []


def test_in_flight_stale_dispatches(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_AI_REVIEW_STARTED, _HASH_A, _STALE)},
    )

    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_retry_backoff_waits(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_CANCELLED, _HASH_A, _FRESH)},
    )

    assert scan.dispatched == []


def test_retry_aged_dispatches(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_CANCELLED, _HASH_A, _STALE)},
    )

    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_max_caps_only_dispatches(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1), _open_pr(2), _open_pr(3)],
        fingerprints={1: ("headsha1", _HASH_B), 2: ("headsha2", _HASH_A), 3: ("headsha3", _HASH_A)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _NEW), 2: _state(2, STATUS_LAND, _HASH_A, _NEW)},
        max_dispatches=1,
    )

    # PR2 skips (decided, same hash); PR1 and PR3 both dispatch, but the cap of 1 must go to
    # the stalest (never-reviewed PR3) and the skip must not consume the single slot.
    assert scan.dispatched == [(3, "headsha3", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_max_zero_dispatches_nothing(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        max_dispatches=0,
    )

    assert scan.dispatched == []


def test_pr_targets_single_pr_bypasses_listing(make_config):
    scan = _run_scan(make_config, pr=5, listed=[_open_pr(1)], fingerprints={5: ("headsha5", _HASH_A)})

    assert scan.dispatched == [(5, "headsha5", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert scan.listed_calls == 0
    assert scan.fingerprinted == [5]
    assert scan.read_calls == [(review.TARGET_REPO, [5])]


def test_pr_decided_still_skips(make_config):
    scan = _run_scan(
        make_config,
        pr=5,
        fingerprints={5: ("headsha5", _HASH_A)},
        states={5: _state(5, STATUS_LAND, _HASH_A, _NEW)},
    )

    assert scan.dispatched == []
    assert scan.listed_calls == 0


def test_ref_forwarded_to_dispatch(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        ref="release/2.9",
    )

    assert scan.dispatched == [(1, "headsha1", _HASH_A, "release/2.9")]


def test_fair_ordering_never_reviewed_then_oldest_first(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1), _open_pr(2), _open_pr(3)],
        fingerprints={1: ("headsha1", _HASH_B), 2: ("headsha2", _HASH_A), 3: ("headsha3", _HASH_B)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _NEW), 3: _state(3, STATUS_LAND, _HASH_A, _OLD)},
    )

    assert [number for number, *_ in scan.dispatched] == [2, 3, 1]


def test_timeout_minutes_default_waits(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_AI_REVIEW_STARTED, _HASH_A, _NOW - timedelta(minutes=20))},
    )

    assert scan.dispatched == []


def test_timeout_minutes_override_dispatches(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_AI_REVIEW_STARTED, _HASH_A, _NOW - timedelta(minutes=20))},
        timeout_minutes=10,
    )

    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_read_state_called_once_with_all_candidates(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1), _open_pr(2), _open_pr(3)],
        fingerprints={1: ("h1", _HASH_A), 2: ("h2", _HASH_A), 3: ("h3", _HASH_A)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _NEW), 2: _state(2, STATUS_LAND, _HASH_A, _NEW)},
    )

    assert scan.read_calls == [(review.TARGET_REPO, [1, 2, 3])]


def test_no_candidates_dispatches_nothing(make_config):
    scan = _run_scan(make_config, listed=[], fingerprints={})

    assert scan.dispatched == []
    assert scan.fingerprinted == []
    assert scan.read_calls == [(review.TARGET_REPO, [])]


def test_poison_pill_isolates_pr_but_scan_still_raises(make_config, caplog):
    dispatched: list[tuple[int, str, str, str]] = []

    def boom_fingerprint(_client, number):
        if number == 1:
            raise RuntimeError("fingerprint boom")
        return (f"headsha{number}", _HASH_A)

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref):
        dispatched.append((number, head_sha, eval_hash, dispatch_ref))

    with (
        caplog.at_level(logging.ERROR, logger="greenlight"),
        pytest.raises(RuntimeError, match=r"1 PR\(s\) failed during scan: \[1\]"),
    ):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=boom_fingerprint,
            read_state=lambda _repo, _numbers: {2: _state(2, STATUS_LAND, _HASH_A, _NEW)},
            dispatch=fake_dispatch,
            now=lambda: _NOW,
        )

    # PR1's fingerprint raises: it is skipped and recorded as failed, yet PR2 (SKIP, same
    # hash) and PR3 (never-reviewed) are still evaluated and healthy PR3 is dispatched
    # before the aggregate failure surfaces.
    assert [number for number, *_ in dispatched] == [3]
    assert "skipping PR #1" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_deferred_dispatch_is_logged(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        _run_scan(
            make_config,
            listed=[_open_pr(1), _open_pr(2)],
            fingerprints={1: ("h1", _HASH_A), 2: ("h2", _HASH_A)},
            max_dispatches=1,
        )

    assert "dispatched review for PR #" in caplog.text
    assert "deferred PR #" in caplog.text
    assert "--max cap reached" in caplog.text


def test_listing_path_logs_open_prs_and_decisions(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        _run_scan(
            make_config,
            listed=[_open_pr(1), _open_pr(2)],
            fingerprints={1: ("h1", _HASH_A), 2: ("h2", _HASH_A)},
            states={2: _state(2, STATUS_LAND, _HASH_A, _NEW)},
        )

    messages = caplog.text
    assert "found 2 open PR(s)" in messages
    assert "open PR #1 by albanD" in messages
    assert "PR #1: DISPATCH (never_reviewed)" in messages
    assert "PR #2: SKIP (decided)" in messages


def test_run_without_token_raises(make_config):
    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        review.run(make_config(github_token=None))


def test_default_fetch_forwards_to_list_open_prs(monkeypatch):
    captured: dict[str, object] = {}
    expected = [_open_pr(1)]

    def fake_list(client, repo, authors):
        captured["client"] = client
        captured["repo"] = repo
        captured["authors"] = set(authors)
        return expected

    monkeypatch.setattr(github_client, "list_open_prs_by_authors", fake_list)

    result = review._default_fetch(_CLIENT)

    assert result is expected
    assert captured["client"] is _CLIENT
    assert captured["repo"] == review.TARGET_REPO
    assert captured["authors"] == review.TRUSTED_AUTHORS


def test_default_fingerprint_forwards_to_fingerprint_pr(monkeypatch):
    captured: dict[str, object] = {}

    def fake_fingerprint_pr(client, repo, pr_number):
        captured["client"] = client
        captured["repo"] = repo
        captured["pr_number"] = pr_number
        return ("headsha", _HASH_A)

    monkeypatch.setattr(github_client, "fingerprint_pr", fake_fingerprint_pr)

    result = review._default_fingerprint(_CLIENT, 7)

    assert result == ("headsha", _HASH_A)
    assert captured["client"] is _CLIENT
    assert captured["repo"] == review.TARGET_REPO
    assert captured["pr_number"] == 7


def test_utcnow_is_naive_utc():
    now = review._utcnow()

    assert now.tzinfo is None
