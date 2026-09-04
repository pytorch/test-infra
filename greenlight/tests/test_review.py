from __future__ import annotations

import logging
import queue
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, NoReturn, cast
from unittest.mock import Mock

import pytest

from greenlight import (
    clickhouse_client,
    cohort,
    drci_poke,
    github_client,
    revert_guard,
    review,
    scan_runner,
    state_emit,
)
from greenlight.comment_format import RECHECK_REFUSAL_MARKER
from greenlight.constants import (
    DEFAULT_DISPATCH_REF,
    DEFAULT_TIMEOUT_MINUTES,
    STATUS_AI_REVIEW_STARTED,
    STATUS_CANCELLED,
    STATUS_FAILED,
    STATUS_LAND,
    STATUS_REVERTED,
    TARGET_REPO,
)
from greenlight.github_client import OpenPR
from greenlight.guards import IterationTimeout
from greenlight.review_gate import CHANGES_REQUESTED, HUMAN_APPROVED, ReviewSkip
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
_AUTHORIZED = frozenset({"alband", "alice", "bob"})
_NOW = datetime(2026, 7, 31, 12, 0, 0)
_FRESH = _NOW - timedelta(minutes=10)
_STALE = _NOW - timedelta(minutes=50)
_OLD = _NOW - timedelta(days=2)
_NEW = _NOW - timedelta(hours=1)


def _open_pr(
    number: int,
    *,
    head_sha: str | None = None,
    updated_at: datetime | None = None,
    labels: tuple[str, ...] = (),
    author: str = "albanD",
) -> OpenPR:
    return OpenPR(
        repo=TARGET_REPO,
        number=number,
        author=author,
        title=f"fix {number}",
        url=f"https://example.test/{number}",
        head_sha=head_sha or f"headsha{number}",
        updated_at=updated_at,
        labels=labels,
    )


def _boom_poke(repo: str, pr_number: int, poke_config: Config) -> NoReturn:
    raise AssertionError(f"poke should not be called for {repo}#{pr_number}")


def _no_reverted(_repo: str, _numbers: Sequence[int]) -> set[int]:
    return set()


@dataclass(frozen=True)
class _FakeHead:
    sha: str


@dataclass(frozen=True)
class _FakePR:
    number: int
    head: _FakeHead


def _state(number: int, status: str, eval_hash: str, version: datetime, run_id: int = 0) -> PRState:
    return PRState(
        pr_number=number, status=status, eval_hash=eval_hash, head_sha=f"rec{number}", version=version, run_id=run_id
    )


@pytest.fixture(autouse=True)
def _no_real_s3_upload(monkeypatch):
    # review.run's default emit_dispatched seam PUTs the AI_REVIEW_DISPATCHED row to S3 via boto3;
    # its default arg is bound at import, so neutralise the deeper upload so no test can touch AWS.
    # Tests asserting the marker inject their own emit_dispatched seam and never reach this.
    monkeypatch.setattr(state_emit, "_default_upload", lambda _row, _key: None)


@pytest.fixture(autouse=True)
def _no_real_drci_post(monkeypatch):
    # Same guard for review.run's default poke_drci seam, which POSTs to the live Dr. CI endpoint.
    # Both its own `post` default and review.run's `poke_drci` default are bound at import, so the
    # only interceptable layer is urllib3 itself. Tests asserting the poke inject their own seam.
    import urllib3

    def unreachable(**_kwargs: object) -> object:
        raise AssertionError("a test reached the live Dr. CI endpoint")

    monkeypatch.setattr(urllib3, "PoolManager", unreachable)


@pytest.fixture(autouse=True)
def _no_real_clickhouse_read(monkeypatch):
    # Same guard for review.run's default read_reverted seam, which SELECTs from ClickHouse. That
    # default and read_reverted_pr_numbers' own `connect` default are both bound at import, so the
    # only interceptable layer is inside connect() itself. Every test injects its own read_reverted.
    def unreachable() -> str:
        raise AssertionError("a test reached the live ClickHouse endpoint")

    monkeypatch.setattr(clickhouse_client, "_host_from_env", unreachable)


@dataclass
class _Scan:
    dispatched: list[tuple[int, str, str, str]]
    read_calls: list[tuple[str, list[int]]]
    fingerprinted: list[int]
    listed_calls: int
    resolver_calls: int
    authorized_seen: list[frozenset[str]]
    author_fetched: list[int]
    skip_on_approval_seen: list[bool]
    refusals: list[tuple[int, str, str, str]]
    emitted: list[tuple[str, int, str, str, int]]
    poked: list[tuple[str, int, Config]]
    events: list[str]
    label_fetches: list[int]
    dismissals: list[tuple[int, str, str]]
    reverted_emitted: list[tuple[str, int, str, int]]
    dispatch_shadow: list[tuple[int, bool]]
    emit_shadow: list[tuple[int, bool]]
    reverted_shadow: list[tuple[int, bool]]


def _run_scan(
    make_config: Callable[..., Config],
    *,
    fingerprints: dict[int, tuple[str, str] | ReviewSkip],
    listed: Sequence[OpenPR] = (),
    states: dict[int, PRState] | None = None,
    pr: int | None = None,
    max_dispatches: int | None = None,
    ref: str = DEFAULT_DISPATCH_REF,
    timeout_minutes: int = DEFAULT_TIMEOUT_MINUTES,
    force: bool = False,
    authorized: frozenset[str] = _AUTHORIZED,
    now: datetime = _NOW,
    requester: str | None = None,
    allow_untrusted_author: bool = False,
    author: str | None = "albanD",
    bot_login: str = "",
    config_kwargs: dict[str, object] | None = None,
    reverted: frozenset[int] = frozenset(),
    fetched_labels: dict[int, tuple[str, ...]] | None = None,
    dismissed_ids: dict[int, list[int]] | None = None,
    dismiss_errors: dict[int, Exception] | None = None,
) -> _Scan:
    states = states or {}
    fetched_labels = fetched_labels or {}
    dismissed_ids = dismissed_ids or {}
    dismiss_errors = dismiss_errors or {}
    dispatched: list[tuple[int, str, str, str]] = []
    read_calls: list[tuple[str, list[int]]] = []
    fingerprinted: list[int] = []
    listed_calls: list[int] = []
    resolver_calls: list[int] = []
    authorized_seen: list[frozenset[str]] = []
    author_fetched: list[int] = []
    skip_on_approval_seen: list[bool] = []
    refusals: list[tuple[int, str, str, str]] = []
    emitted: list[tuple[str, int, str, str, int]] = []
    poked: list[tuple[str, int, Config]] = []
    events: list[str] = []
    label_fetches: list[int] = []
    dismissals: list[tuple[int, str, str]] = []
    reverted_emitted: list[tuple[str, int, str, int]] = []
    dispatch_shadow: list[tuple[int, bool]] = []
    emit_shadow: list[tuple[int, bool]] = []
    reverted_shadow: list[tuple[int, bool]] = []

    def fake_fetch(_client):
        listed_calls.append(1)
        return list(listed)

    def fake_fingerprint(_client, number, authorized_logins, skip_on_approval):
        fingerprinted.append(number)
        authorized_seen.append(authorized_logins)
        skip_on_approval_seen.append(skip_on_approval)
        return fingerprints[number]

    def fake_read_state(repo, numbers):
        nums = list(numbers)
        read_calls.append((repo, nums))
        return {n: states[n] for n in nums if n in states}

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref, *, shadow):
        dispatched.append((number, head_sha, eval_hash, dispatch_ref))
        dispatch_shadow.append((number, shadow))
        events.append(f"dispatch:{number}")

    def fake_resolve_authorized():
        resolver_calls.append(1)
        return authorized

    def fake_fetch_author(_client, number):
        author_fetched.append(number)
        return author

    def fake_get_pr(_client, _repo, number):
        # The comment upsert and the review dismissal are both faked, so the "PR" object need only
        # carry back its number and the head_sha the reverted-PR row is written from.
        return _FakePR(number, _FakeHead(f"headsha{number}"))

    def fake_upsert(pr, *, marker, body, author_login, run_id=None):
        refusals.append((pr.number, marker, body, author_login))

    def fake_emit(*, repo, pr_number, head_sha, eval_hash, run_id, shadow):
        emitted.append((repo, pr_number, head_sha, eval_hash, run_id))
        emit_shadow.append((pr_number, shadow))
        events.append(f"emit:{pr_number}")

    def fake_poke(repo, pr_number, poke_config):
        poked.append((repo, pr_number, poke_config))
        events.append(f"poke:{pr_number}")

    def fake_read_reverted(_repo, numbers):
        return {n for n in numbers if n in reverted}

    def fake_fetch_labels(_client, _repo, number):
        label_fetches.append(number)
        return fetched_labels.get(number, ())

    def fake_dismiss(pr, *, bot_login, message):
        dismissals.append((pr.number, bot_login, message))
        events.append(f"dismiss:{pr.number}")
        error = dismiss_errors.get(pr.number)
        if error is not None:
            raise error
        return list(dismissed_ids.get(pr.number, ()))

    def fake_emit_reverted(*, repo, pr_number, head_sha, run_id, shadow):
        reverted_emitted.append((repo, pr_number, head_sha, run_id))
        reverted_shadow.append((pr_number, shadow))
        events.append(f"emit_reverted:{pr_number}")

    review.run(
        make_config(github_token="t", **(config_kwargs or {})),
        pr=pr,
        max_dispatches=max_dispatches,
        ref=ref,
        timeout_minutes=timeout_minutes,
        force=force,
        requester=requester,
        allow_untrusted_author=allow_untrusted_author,
        bot_login=bot_login,
        build_github=lambda _token, **_kwargs: _CLIENT,
        fetch=fake_fetch,
        fetch_author=fake_fetch_author,
        fetch_labels=fake_fetch_labels,
        fingerprint=fake_fingerprint,
        read_state=fake_read_state,
        read_reverted=fake_read_reverted,
        dispatch=fake_dispatch,
        emit_dispatched=fake_emit,
        emit_reverted=fake_emit_reverted,
        poke_drci=fake_poke,
        get_pr=fake_get_pr,
        dismiss_approvals=fake_dismiss,
        upsert_comment=fake_upsert,
        resolve_authorized=fake_resolve_authorized,
        now=lambda: now,
    )
    return _Scan(
        dispatched=dispatched,
        read_calls=read_calls,
        fingerprinted=fingerprinted,
        listed_calls=len(listed_calls),
        resolver_calls=len(resolver_calls),
        authorized_seen=authorized_seen,
        author_fetched=author_fetched,
        skip_on_approval_seen=skip_on_approval_seen,
        refusals=refusals,
        emitted=emitted,
        poked=poked,
        events=events,
        label_fetches=label_fetches,
        dismissals=dismissals,
        reverted_emitted=reverted_emitted,
        dispatch_shadow=dispatch_shadow,
        emit_shadow=emit_shadow,
        reverted_shadow=reverted_shadow,
    )


def test_never_reviewed_dispatches(make_config):
    scan = _run_scan(make_config, listed=[_open_pr(1)], fingerprints={1: ("headsha1", _HASH_A)})

    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert scan.fingerprinted == [1]
    assert scan.read_calls == [(TARGET_REPO, [1])]


def test_dispatch_emits_dispatched_marker_never_reviewed(make_config):
    scan = _run_scan(make_config, listed=[_open_pr(1)], fingerprints={1: ("headsha1", _HASH_A)})

    # review.run threads emit_dispatched to the dispatch loop: a never-reviewed PR emits one marker
    # (run_id 1) carrying the same repo/head_sha/eval_hash the dispatch used.
    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert scan.emitted == [(TARGET_REPO, 1, "headsha1", _HASH_A, 1)]


def test_dispatch_emits_dispatched_marker_supersedes_prior_run(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_B)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _NEW, run_id=7)},
    )

    # A changed-hash re-dispatch supersedes the PR's prior terminal row (run_id 7) with run_id 8.
    assert scan.dispatched == [(1, "headsha1", _HASH_B, DEFAULT_DISPATCH_REF)]
    assert scan.emitted == [(TARGET_REPO, 1, "headsha1", _HASH_B, 8)]


def test_skip_does_not_emit_dispatched_marker(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _NEW)},
    )

    # A decided PR with an unchanged hash is neither dispatched nor marked in-flight.
    assert scan.dispatched == []
    assert scan.emitted == []
    assert scan.poked == []


def test_dispatch_pokes_drci_after_the_marker_emit(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1), _open_pr(2)],
        fingerprints={1: ("headsha1", _HASH_A), 2: ("headsha2", _HASH_A)},
        config_kwargs={"drci_token": "drci-key"},
    )

    # Dr. CI re-reads the state row when poked, so each poke must follow its own marker emit;
    # without the poke the PR shows no in-flight marker until Dr. CI's next 15-minute sweep.
    assert scan.events == ["dispatch:1", "emit:1", "poke:1", "dispatch:2", "emit:2", "poke:2"]
    assert [(repo, number) for repo, number, _ in scan.poked] == [(TARGET_REPO, 1), (TARGET_REPO, 2)]


def test_poke_drops_the_ingestion_delay_but_keeps_the_credentials(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ("headsha1", _HASH_A)},
        config_kwargs={
            "drci_token": "drci-key",
            "drci_internal_token": "hud-key",
            "drci_poke_delay_seconds": 30.0,
        },
    )

    # The configured delay covers the verdict path's write-then-upload-in-a-later-step gap. The scan
    # has already PUT the row to S3 by the time it pokes, and one such sleep per dispatch would
    # accumulate against the Lambda's function timeout, so this path waits zero. Everything else the
    # poke needs must survive the override -- a dropped token silently downgrades it to a warning.
    (_, _, poke_config) = scan.poked[0]
    assert poke_config.drci_poke_delay_seconds == 0.0
    assert poke_config.drci_token == "drci-key"
    assert poke_config.drci_internal_token == "hud-key"


def test_run_default_poke_seam_is_drci_poke():
    import inspect

    # The injected fakes above cannot see the production wiring; pin it here so the seam cannot be
    # left pointing at a stub.
    assert inspect.signature(review.run).parameters["poke_drci"].default is drci_poke.poke


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


def test_recency_window_in_window_pr_is_processed(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=_NEW)],
        fingerprints={1: ("headsha1", _HASH_A)},
    )

    # Updated within the 24h window: fingerprinted and dispatched (never reviewed).
    assert scan.fingerprinted == [1]
    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_recency_window_out_of_window_never_reviewed_is_skipped(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=_OLD)],
        fingerprints={1: ("headsha1", _HASH_A)},
    )

    # Stale and never reviewed: pruned before fingerprinting -- the whole point of the window.
    assert scan.fingerprinted == []
    assert scan.dispatched == []
    # State is still read for the full candidate set before the window prunes it.
    assert scan.read_calls == [(TARGET_REPO, [1])]


def test_recency_window_out_of_window_terminal_is_skipped(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=_OLD)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _OLD)},
    )

    # Stale and terminal (decided): its hash cannot have changed, so skip without fingerprinting.
    assert scan.fingerprinted == []
    assert scan.dispatched == []


@pytest.mark.parametrize("status", [STATUS_AI_REVIEW_STARTED, STATUS_CANCELLED, STATUS_FAILED])
def test_recency_window_out_of_window_nonterminal_is_still_processed(make_config, status):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=_OLD)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, status, _HASH_A, _STALE)},
    )

    # The guard: a non-terminal ledger state (in-flight / retry) is re-checked even when stale, so
    # the aged version lets decide re-dispatch it (timed_out / retry) -- the window never hides it.
    assert scan.fingerprinted == [1]
    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_recency_window_updated_at_none_is_processed(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=None)],
        fingerprints={1: ("headsha1b", _HASH_B)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _OLD)},
    )

    # A missing updated_at is never treated as stale: the PR is fingerprinted, and the changed hash
    # re-dispatches it. Were None wrongly treated as out-of-window, this terminal PR would be skipped.
    assert scan.fingerprinted == [1]
    assert scan.dispatched == [(1, "headsha1b", _HASH_B, DEFAULT_DISPATCH_REF)]


def test_recency_window_pr_target_is_exempt(make_config):
    scan = _run_scan(
        make_config,
        pr=5,
        fingerprints={5: ("headsha5", _HASH_A)},
        states={5: _state(5, STATUS_LAND, _HASH_A, _OLD)},
    )

    # A single --pr target bypasses the window entirely: it is always fingerprinted and evaluated
    # (here it only SKIPs because decide finds the hash unchanged, not because of the window).
    assert scan.fingerprinted == [5]
    assert scan.dispatched == []


def test_recency_window_mixed_batch_prunes_only_stale_skippable(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=_NEW), _open_pr(2, updated_at=_OLD), _open_pr(3, updated_at=_OLD)],
        fingerprints={1: ("h1", _HASH_A), 2: ("h2", _HASH_A), 3: ("h3", _HASH_A)},
        states={2: _state(2, STATUS_LAND, _HASH_A, _OLD)},
    )

    # read_state covers all three candidates before the window prunes any. PR1 (in-window) is
    # processed and dispatched; PR2 (stale terminal) and PR3 (stale never-reviewed) are pruned.
    assert scan.read_calls == [(TARGET_REPO, [1, 2, 3])]
    assert scan.fingerprinted == [1]
    assert scan.dispatched == [(1, "h1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_recency_window_config_value_drives_cutoff(make_config):
    recent = _NOW - timedelta(minutes=30)
    old = _NOW - timedelta(hours=2)
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=recent), _open_pr(2, updated_at=old)],
        fingerprints={1: ("h1", _HASH_A), 2: ("h2", _HASH_A)},
        config_kwargs={"review_window_hours": 1.0},
    )

    # With the window shrunk to 1h, the 30-min-old PR1 is kept but the 2h-old PR2 is pruned. At the
    # 24h default both would be kept, so this proves the config value -- not a hardcoded 24h -- is
    # the cutoff that drives the filter.
    assert scan.fingerprinted == [1]
    assert scan.dispatched == [(1, "h1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_recency_window_exactly_at_edge_is_out_of_window(make_config):
    at_edge = _NOW - timedelta(hours=24)
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=at_edge)],
        fingerprints={1: ("h1", _HASH_A)},
    )

    # updated_at exactly window-old: now - updated_at == window, and the strict `<` treats the edge
    # as out-of-window, so this never-reviewed PR is pruned rather than fingerprinted.
    assert scan.fingerprinted == []
    assert scan.dispatched == []


def test_stale_label_in_window_never_reviewed_is_skipped(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        scan = _run_scan(
            make_config,
            listed=[_open_pr(1, updated_at=_NEW, labels=("Stale",))],
            fingerprints={1: ("headsha1", _HASH_A)},
        )

    # The stale bot bumps updated_at when it applies "Stale", so this PR is inside the window yet
    # abandoned. The label prunes it -- never fingerprinted, never dispatched.
    assert scan.fingerprinted == []
    assert scan.dispatched == []
    assert "skipping PR #1: Stale label (never reviewed)" in caplog.text


def test_stale_label_in_window_terminal_is_skipped(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        scan = _run_scan(
            make_config,
            listed=[_open_pr(1, updated_at=_NEW, labels=("Stale",))],
            fingerprints={1: ("headsha1", _HASH_A)},
            states={1: _state(1, STATUS_LAND, _HASH_A, _NEW)},
        )

    # Stale-labeled and terminal (decided): its eval_hash cannot have changed, so the label prunes it
    # without fingerprinting just as the never-reviewed case does -- but the skip log carries the
    # recorded status, exercising the detail = recorded.status branch for a Stale-labeled PR.
    assert scan.fingerprinted == []
    assert scan.dispatched == []
    assert f"skipping PR #1: Stale label ({STATUS_LAND})" in caplog.text


@pytest.mark.parametrize("status", [STATUS_AI_REVIEW_STARTED, STATUS_CANCELLED, STATUS_FAILED])
def test_stale_label_nonterminal_state_is_still_processed(make_config, status):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=_NEW, labels=("Stale",))],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, status, _HASH_A, _STALE)},
    )

    # A non-terminal ledger state (in-flight / retry) survives the Stale label exactly as it survives
    # the recency window: the PR is re-checked so decide can re-dispatch it on timeout/retry.
    assert scan.fingerprinted == [1]
    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]


@pytest.mark.parametrize("label", ["enhancement", "stale", "STALE"])
def test_non_stale_label_in_window_is_not_skipped(make_config, label):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=_NEW, labels=(label,))],
        fingerprints={1: ("headsha1", _HASH_A)},
    )

    # Control: only the exact case-sensitive "Stale" prunes. Any other label -- including the
    # lowercase/uppercase variants -- leaves an in-window never-reviewed PR fingerprinted.
    assert scan.fingerprinted == [1]
    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_stale_label_pr_target_is_exempt(make_config):
    scan = _run_scan(
        make_config,
        pr=5,
        listed=[_open_pr(5, updated_at=_OLD, labels=("Stale",))],
        fingerprints={5: ("headsha5", _HASH_A)},
    )

    # A single --pr target bypasses listing entirely (listed_calls == 0), so the Stale label -- which
    # only ever comes from the listing -- can never suppress a manual recheck.
    assert scan.listed_calls == 0
    assert scan.fingerprinted == [5]
    assert scan.dispatched == [(5, "headsha5", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_reverted_label_drops_pr_before_fingerprinting(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        scan = _run_scan(
            make_config,
            listed=[_open_pr(1, updated_at=_NEW, labels=("Reverted",)), _open_pr(2, updated_at=_NEW)],
            fingerprints={1: ("headsha1", _HASH_A), 2: ("headsha2", _HASH_A)},
            bot_login="greenlight-app[bot]",
            dismissed_ids={1: [901]},
        )

    # The reverted PR is dropped before the fingerprint stage -- its approval revoked, its exclusion
    # recorded, Dr. CI poked -- while the healthy PR2 in the same batch is unaffected.
    assert scan.fingerprinted == [2]
    assert [number for number, *_ in scan.dispatched] == [2]
    assert scan.dismissals == [(1, "greenlight-app[bot]", revert_guard._DISMISS_MESSAGE)]
    assert scan.reverted_emitted == [(TARGET_REPO, 1, "headsha1", 1)]
    assert 1 in [pr_number for _repo, pr_number, _config in scan.poked]
    assert "excluding 1 reverted PR(s) from review: [1]" in caplog.text


def test_reverted_row_still_excludes_after_the_label_is_removed(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=_NEW)],
        fingerprints={1: ("headsha1", _HASH_A)},
        states={1: _state(1, STATUS_REVERTED, _HASH_A, _NEW, run_id=3)},
        reverted=frozenset({1}),
        bot_login="greenlight-app[bot]",
    )

    # The no-escape guarantee: with the label gone the recorded row alone keeps the PR out, and the
    # settled exclusion is not rewritten.
    assert scan.fingerprinted == []
    assert scan.dispatched == []
    assert scan.reverted_emitted == []
    assert scan.poked == []


def test_reverted_pr_target_is_not_exempt_and_is_dropped_silently(make_config):
    scan = _run_scan(
        make_config,
        pr=5,
        fingerprints={5: ("headsha5", _HASH_A)},
        fetched_labels={5: ("Reverted",)},
        bot_login="greenlight-app[bot]",
    )

    # Unlike Stale, a revert is not waived by an explicit recheck. The --pr path has no listing to
    # read labels from, so it fetches them for its one target; the PR is then dropped with no
    # refusal comment -- the recheck is simply a no-op.
    assert scan.label_fetches == [5]
    assert scan.fingerprinted == []
    assert scan.dispatched == []
    assert scan.refusals == []
    assert scan.reverted_emitted == [(TARGET_REPO, 5, "headsha5", 1)]


def test_reverted_dismissal_failure_fails_the_scan_and_writes_no_row(make_config, caplog):
    with (
        caplog.at_level(logging.ERROR, logger="greenlight"),
        pytest.raises(RuntimeError, match=r"1 PR\(s\) failed during scan: \[1\]"),
    ):
        _run_scan(
            make_config,
            listed=[_open_pr(1, updated_at=_NEW, labels=("Reverted",))],
            fingerprints={1: ("headsha1", _HASH_A)},
            bot_login="greenlight-app[bot]",
            dismiss_errors={1: RuntimeError("dismiss boom")},
        )

    # No row is written, so the next scan retries the dismissal; the scan still fails closed.
    assert "failed to revoke greenlight approval on reverted PR #1" in caplog.text


def test_reverted_rate_limit_defers_the_fanout_and_the_dispatch_phase(make_config, caplog):
    from github import RateLimitExceededException

    with caplog.at_level(logging.WARNING, logger="greenlight"), pytest.raises(RuntimeError) as excinfo:
        _run_scan(
            make_config,
            listed=[_open_pr(1, updated_at=_NEW, labels=("Reverted",)), _open_pr(2, updated_at=_NEW)],
            fingerprints={2: ("headsha2", _HASH_A)},
            bot_login="greenlight-app[bot]",
            dismiss_errors={1: RateLimitExceededException(403)},
        )

    # A rate limit here is classified exactly as one in the fingerprint stage: it trips the same
    # shared cancel event, so PR2 is abandoned unfingerprinted and the dispatch phase is skipped.
    message = str(excinfo.value)
    assert "1 PR(s) failed during scan: [1]" in message
    assert "1 PR(s) abandoned due to rate limit: [2]" in message
    assert "abandoned 1 of 1" in caplog.text


def test_reverted_without_app_bot_login_raises(make_config):
    # BOT_LOGIN is load-bearing for the dismissal, so the scheduled path fails loudly rather than
    # "dismissing" nothing and then recording an exclusion that suppresses every retry.
    with pytest.raises(ValueError, match="BOT_LOGIN must be the greenlight App login"):
        _run_scan(
            make_config,
            listed=[_open_pr(1, updated_at=_NEW, labels=("Reverted",))],
            fingerprints={1: ("headsha1", _HASH_A)},
            bot_login="",
        )


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
    # A zero cap does no work at all: nothing is fingerprinted, not just nothing dispatched.
    assert scan.fingerprinted == []


def test_max_with_no_candidates_dispatches_nothing(make_config):
    scan = _run_scan(make_config, listed=[], fingerprints={}, max_dispatches=1)

    assert scan.dispatched == []
    assert scan.fingerprinted == []
    assert scan.read_calls == [(TARGET_REPO, [])]


def test_max_early_stop_limits_fingerprints(make_config):
    numbers = list(range(1, 30))
    scan = _run_scan(
        make_config,
        listed=[_open_pr(n) for n in numbers],
        fingerprints={n: (f"headsha{n}", _HASH_A) for n in numbers},
        max_dispatches=1,
    )

    # 29 equally stale never-reviewed PRs: staleness ties break on listing order, so PR1 takes the
    # single slot. Early-stop fingerprints only the first worker-sized batch, never all 29.
    assert scan.dispatched == [(1, "headsha1", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert sorted(scan.fingerprinted) == list(range(1, review._FINGERPRINT_WORKERS + 1))


def test_max_dispatches_most_stale_first(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1), _open_pr(2), _open_pr(3)],
        fingerprints={1: ("headsha1", _HASH_B), 2: ("headsha2", _HASH_A), 3: ("headsha3", _HASH_B)},
        states={1: _state(1, STATUS_LAND, _HASH_A, _NEW), 3: _state(3, STATUS_LAND, _HASH_A, _OLD)},
        max_dispatches=2,
    )

    # Same inputs as the --max-None fairness test but capped at 2: the two stalest dispatchable
    # (never-reviewed PR2, then oldest-recorded PR3) dispatch in staleness order; PR1 is deferred.
    assert [number for number, *_ in scan.dispatched] == [2, 3]


def test_max_continues_past_non_dispatch_batches(make_config):
    stale_decided = list(range(1, review._FINGERPRINT_WORKERS + 1))
    target = review._FINGERPRINT_WORKERS + 1
    numbers = [*stale_decided, target]
    scan = _run_scan(
        make_config,
        listed=[_open_pr(n) for n in numbers],
        fingerprints={
            **{n: (f"headsha{n}", _HASH_A) for n in stale_decided},
            target: (f"headsha{target}", _HASH_B),
        },
        states={
            **{n: _state(n, STATUS_LAND, _HASH_A, _OLD) for n in stale_decided},
            target: _state(target, STATUS_LAND, _HASH_A, _NEW),
        },
        max_dispatches=1,
    )

    # The stalest PRs all SKIP (decided, unchanged) and fill the first batch with no dispatchable, so
    # early-stop must fingerprint into the second batch to reach the lone changed PR -- SKIP PRs
    # ahead of the Kth dispatchable are still fingerprinted.
    assert scan.dispatched == [(target, f"headsha{target}", _HASH_B, DEFAULT_DISPATCH_REF)]
    assert sorted(scan.fingerprinted) == numbers


def test_max_fingerprint_failure_still_raises(make_config, caplog):
    numbers = list(range(1, 30))
    dispatched: list[int] = []

    def boom_fingerprint(_client, number, _authorized, _skip):
        if number == 3:
            raise RuntimeError("fingerprint boom")
        return (f"headsha{number}", _HASH_A)

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref, *, shadow):
        dispatched.append(number)

    with (
        caplog.at_level(logging.ERROR, logger="greenlight"),
        pytest.raises(RuntimeError, match=r"1 PR\(s\) failed during scan: \[3\]"),
    ):
        review.run(
            make_config(github_token="t"),
            max_dispatches=1,
            build_github=lambda _token, **_kwargs: _CLIENT,
            fetch=lambda _client: [_open_pr(n) for n in numbers],
            fingerprint=boom_fingerprint,
            read_state=lambda _repo, _numbers: {},
            read_reverted=_no_reverted,
            dispatch=fake_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # PR3 sits in the first (only) launched batch, so its fingerprint failure is attempted and
    # surfaces as the aggregate RuntimeError; the healthy stalest PR1 still dispatches first, and the
    # never-fingerprinted PRs beyond that batch are absent from the sorted failed list.
    assert dispatched == [1]
    assert "skipping PR #3" in caplog.text


def test_pr_targets_single_pr_bypasses_listing(make_config):
    scan = _run_scan(make_config, pr=5, listed=[_open_pr(1)], fingerprints={5: ("headsha5", _HASH_A)})

    assert scan.dispatched == [(5, "headsha5", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert scan.listed_calls == 0
    assert scan.fingerprinted == [5]
    assert scan.read_calls == [(TARGET_REPO, [5])]


def test_pr_decided_still_skips(make_config):
    scan = _run_scan(
        make_config,
        pr=5,
        fingerprints={5: ("headsha5", _HASH_A)},
        states={5: _state(5, STATUS_LAND, _HASH_A, _NEW)},
    )

    assert scan.dispatched == []
    assert scan.listed_calls == 0


def test_pr_untrusted_target_author_is_refused(make_config, caplog):
    with caplog.at_level(logging.WARNING, logger="greenlight"):
        scan = _run_scan(
            make_config,
            pr=5,
            fingerprints={5: ("headsha5", _HASH_A)},
            author="mallory",
        )

    # --pr on an untrusted-author PR with no requester (the scan/local path): the target-author gate
    # still applies -- the PR is looked up, refused, and never fingerprinted or dispatched.
    assert scan.author_fetched == [5]
    assert scan.fingerprinted == []
    assert scan.dispatched == []
    # A refused --pr does zero merge-rules work: resolve_authorized runs only after the gate.
    assert scan.resolver_calls == 0
    assert "refusing --pr 5" in caplog.text


def test_pr_target_author_none_is_refused(make_config, caplog):
    with caplog.at_level(logging.WARNING, logger="greenlight"):
        scan = _run_scan(
            make_config,
            pr=5,
            fingerprints={5: ("headsha5", _HASH_A)},
            author=None,
        )

    # A PR whose author cannot be resolved (ghost/deleted user) is untrusted by definition: refused.
    assert scan.fingerprinted == []
    assert scan.dispatched == []
    assert scan.resolver_calls == 0
    assert "refusing --pr 5" in caplog.text


def test_requester_untrusted_is_refused_before_any_fetch(make_config, caplog):
    with caplog.at_level(logging.WARNING, logger="greenlight"):
        scan = _run_scan(
            make_config,
            pr=5,
            fingerprints={5: ("headsha5", _HASH_A)},
            requester="mallory",
            author="albanD",
        )

    # An untrusted requester is rejected before any network work: the target author is never even
    # looked up, and nothing is fingerprinted or dispatched.
    assert scan.author_fetched == []
    assert scan.fingerprinted == []
    assert scan.dispatched == []
    # An untrusted requester is refused before the ExitStack, so no merge-rules work happens either.
    assert scan.resolver_calls == 0
    assert "refusing review: requester 'mallory'" in caplog.text


def test_requester_and_target_trusted_proceeds(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        scan = _run_scan(
            make_config,
            pr=5,
            fingerprints={5: ("headsha5", _HASH_A)},
            requester="huydhn",
            author="albanD",
        )

    # Both gates pass: the recheck proceeds (never-reviewed PR dispatches) and the requester is
    # logged for audit.
    assert scan.author_fetched == [5]
    assert scan.dispatched == [(5, "headsha5", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert "review requested by trusted author huydhn" in caplog.text


def test_requester_trusted_matched_case_insensitively(make_config):
    scan = _run_scan(
        make_config,
        pr=5,
        fingerprints={5: ("headsha5", _HASH_A)},
        requester="ALBAND",
    )

    # GitHub logins are case-insensitive, so a trusted requester in any case passes the gate.
    assert scan.dispatched == [(5, "headsha5", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_allow_untrusted_author_bypasses_target_check(make_config):
    scan = _run_scan(
        make_config,
        pr=5,
        fingerprints={5: ("headsha5", _HASH_A)},
        author="mallory",
        allow_untrusted_author=True,
    )

    # The local override waives the refusal, not the lookup: the author is still resolved, and the
    # otherwise-untrusted PR is fingerprinted and dispatched instead of being turned away.
    assert scan.author_fetched == [5]
    assert scan.dispatched == [(5, "headsha5", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_allow_untrusted_author_does_not_bypass_requester_check(make_config, caplog):
    with caplog.at_level(logging.WARNING, logger="greenlight"):
        scan = _run_scan(
            make_config,
            pr=5,
            fingerprints={5: ("headsha5", _HASH_A)},
            requester="mallory",
            author="mallory",
            allow_untrusted_author=True,
        )

    # The override covers ONLY the target-author check; an untrusted requester is still refused.
    assert scan.fingerprinted == []
    assert scan.dispatched == []
    assert "refusing review: requester 'mallory'" in caplog.text


def test_trusted_requester_does_not_bypass_untrusted_target_author(make_config, caplog):
    with caplog.at_level(logging.WARNING, logger="greenlight"):
        scan = _run_scan(
            make_config,
            pr=5,
            fingerprints={5: ("headsha5", _HASH_A)},
            requester="huydhn",
            author="mallory",
        )

    # The core recheck-abuse guard: a TRUSTED requester must NOT bypass the target-author gate. PR 5's
    # untrusted author is still looked up and refused -- no fingerprint, no dispatch, no merge-rules
    # work -- so a trusted requester can never get an arbitrary (untrusted-author) PR reviewed/approved.
    assert scan.author_fetched == [5]
    assert scan.fingerprinted == []
    assert scan.dispatched == []
    assert scan.resolver_calls == 0
    assert "refusing --pr 5" in caplog.text


def test_pr_target_author_matched_case_insensitively(make_config):
    scan = _run_scan(
        make_config,
        pr=5,
        fingerprints={5: ("headsha5", _HASH_A)},
        requester="huydhn",
        author="ALBAND",
    )

    # The target-author gate case-folds too: an uppercase trusted author passes and the PR proceeds.
    assert scan.dispatched == [(5, "headsha5", _HASH_A, DEFAULT_DISPATCH_REF)]


def test_force_dispatches_decided_pr_via_fingerprint_all(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        scan = _run_scan(
            make_config,
            pr=5,
            fingerprints={5: ("headsha5", _HASH_A)},
            states={5: _state(5, STATUS_LAND, _HASH_A, _NEW)},
            force=True,
        )

    # The decided PR from test_pr_decided_still_skips (terminal LAND, unchanged hash) normally SKIPs;
    # force bypasses decide on the max_dispatches=None path (_fingerprint_all) and dispatches it,
    # still using the fingerprint's head_sha/eval_hash and tagging the reason "forced".
    assert scan.dispatched == [(5, "headsha5", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert "PR #5: DISPATCH (forced)" in caplog.text
    assert "dispatched review for PR #5 (forced)" in caplog.text


def test_force_dispatches_decided_pr_via_until_dispatchable(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        scan = _run_scan(
            make_config,
            pr=5,
            fingerprints={5: ("headsha5", _HASH_A)},
            states={5: _state(5, STATUS_LAND, _HASH_A, _NEW)},
            max_dispatches=1,
            force=True,
        )

    # The capped path (_fingerprint_until_dispatchable, selected by a non-None --max) must honor
    # force identically: the same decided PR is dispatched with reason "forced".
    assert scan.dispatched == [(5, "headsha5", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert "PR #5: DISPATCH (forced)" in caplog.text


def test_force_fingerprint_failure_still_raises(make_config, caplog):
    dispatched: list[int] = []

    def boom_fingerprint(_client, _number, _authorized, _skip):
        raise RuntimeError("fingerprint boom")

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref, *, shadow):
        dispatched.append(number)

    with (
        caplog.at_level(logging.ERROR, logger="greenlight"),
        pytest.raises(RuntimeError, match=r"1 PR\(s\) failed during scan: \[7\]"),
    ):
        review.run(
            make_config(github_token="t"),
            pr=7,
            force=True,
            build_github=lambda _token, **_kwargs: _CLIENT,
            fetch=lambda _client: [],
            fetch_author=lambda _client, _number: "albanD",
            fetch_labels=lambda _client, _repo, _number: (),
            fingerprint=boom_fingerprint,
            read_state=lambda _repo, _numbers: {},
            read_reverted=_no_reverted,
            dispatch=fake_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # force short-circuits decide, not the try/except: the fingerprint failure is raised before the
    # force branch is reached, so PR7 is still caught, recorded as failed, and surfaces as the
    # aggregate RuntimeError -- force never bypasses failure handling nor dispatches a failed PR.
    assert dispatched == []
    assert "skipping PR #7" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


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

    assert scan.read_calls == [(TARGET_REPO, [1, 2, 3])]


def test_no_candidates_dispatches_nothing(make_config):
    scan = _run_scan(make_config, listed=[], fingerprints={})

    assert scan.dispatched == []
    assert scan.fingerprinted == []
    assert scan.read_calls == [(TARGET_REPO, [])]


def test_poison_pill_isolates_pr_but_scan_still_raises(make_config, caplog):
    dispatched: list[tuple[int, str, str, str]] = []

    def boom_fingerprint(_client, number, _authorized, _skip):
        if number == 1:
            raise RuntimeError("fingerprint boom")
        return (f"headsha{number}", _HASH_A)

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref, *, shadow):
        dispatched.append((number, head_sha, eval_hash, dispatch_ref))

    with (
        caplog.at_level(logging.ERROR, logger="greenlight"),
        pytest.raises(RuntimeError, match=r"1 PR\(s\) failed during scan: \[1\]"),
    ):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token, **_kwargs: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=boom_fingerprint,
            read_state=lambda _repo, _numbers: {2: _state(2, STATUS_LAND, _HASH_A, _NEW)},
            read_reverted=_no_reverted,
            dispatch=fake_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # PR1's fingerprint raises: it is skipped and recorded as failed, yet PR2 (SKIP, same
    # hash) and PR3 (never-reviewed) are still evaluated and healthy PR3 is dispatched
    # before the aggregate failure surfaces.
    assert [number for number, *_ in dispatched] == [3]
    assert "skipping PR #1" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_concurrent_fingerprint_failures_aggregate_sorted(make_config, caplog):
    dispatched: list[tuple[int, str, str, str]] = []

    def boom_fingerprint(_client, number, _authorized, _skip):
        if number in (1, 3):
            raise RuntimeError(f"fingerprint boom {number}")
        return (f"headsha{number}", _HASH_A)

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref, *, shadow):
        dispatched.append((number, head_sha, eval_hash, dispatch_ref))

    with (
        caplog.at_level(logging.ERROR, logger="greenlight"),
        pytest.raises(RuntimeError, match=r"2 PR\(s\) failed during scan: \[1, 3\]"),
    ):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token, **_kwargs: _CLIENT,
            fetch=lambda _client: [_open_pr(3), _open_pr(1), _open_pr(2)],
            fingerprint=boom_fingerprint,
            read_state=lambda _repo, _numbers: {},
            read_reverted=_no_reverted,
            dispatch=fake_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # Scanned in fetch order [3, 1, 2], so failed is collected as [3, 1]; the sorted(failed) in
    # the RuntimeError reorders that to ascending [1, 3] -- drop that sort and this match fails.
    # Healthy PR2 still dispatches before the aggregate failure surfaces.
    assert [number for number, *_ in dispatched] == [2]
    assert "skipping PR #1" in caplog.text
    assert "skipping PR #3" in caplog.text


def test_dispatch_failure_isolated_others_still_dispatched(make_config, caplog):
    attempted: list[int] = []

    def boom_dispatch(_client, number, _head_sha, _eval_hash, _ref, *, shadow):
        attempted.append(number)
        if number == 2:
            raise RuntimeError("dispatch boom")

    with (
        caplog.at_level(logging.ERROR, logger="greenlight"),
        pytest.raises(RuntimeError, match=r"failed to dispatch 1 PR\(s\): \[2\]"),
    ):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token, **_kwargs: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=lambda _client, number, _authorized, _skip: (f"headsha{number}", _HASH_A),
            read_state=lambda _repo, _numbers: {},
            read_reverted=_no_reverted,
            dispatch=boom_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # PR2's dispatch raises but is isolated: every candidate's dispatch is still attempted, and the
    # failure only surfaces as the aggregate RuntimeError once the whole batch has been processed.
    assert attempted == [1, 2, 3]
    assert "failed to dispatch review for PR #2" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_all_dispatch_failures_all_attempted_then_raise(make_config, caplog):
    attempted: list[int] = []

    def boom_dispatch(_client, number, _head_sha, _eval_hash, _ref, *, shadow):
        attempted.append(number)
        raise RuntimeError(f"dispatch boom {number}")

    with (
        caplog.at_level(logging.ERROR, logger="greenlight"),
        pytest.raises(RuntimeError, match=r"failed to dispatch 3 PR\(s\): \[1, 2, 3\]"),
    ):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token, **_kwargs: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=lambda _client, number, _authorized, _skip: (f"headsha{number}", _HASH_A),
            read_state=lambda _repo, _numbers: {},
            read_reverted=_no_reverted,
            dispatch=boom_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # Even when every dispatch raises, all three are attempted and collected into the single
    # aggregate RuntimeError -- one bad PR never stalls the rest.
    assert attempted == [1, 2, 3]


def test_dispatch_iteration_timeout_propagates_and_halts(make_config):
    attempted: list[int] = []

    def timeout_dispatch(_client, number, _head_sha, _eval_hash, _ref, *, shadow):
        attempted.append(number)
        if number == 1:
            raise IterationTimeout("iteration exceeded")

    with pytest.raises(IterationTimeout):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token, **_kwargs: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=lambda _client, number, _authorized, _skip: (f"headsha{number}", _HASH_A),
            read_state=lambda _repo, _numbers: {},
            read_reverted=_no_reverted,
            dispatch=timeout_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # IterationTimeout is the soft per-iteration control signal, not a dispatch failure: it must
    # propagate immediately past the bare-Exception arm, halting the loop so PR2 and PR3 are never
    # attempted and PR1 is never collected as a dispatch failure.
    assert attempted == [1]


def test_fingerprint_and_dispatch_failures_surface_together(make_config, caplog):
    attempted: list[int] = []

    def boom_fingerprint(_client, number, _authorized, _skip):
        if number == 1:
            raise RuntimeError("fingerprint boom")
        return (f"headsha{number}", _HASH_A)

    def boom_dispatch(_client, number, _head_sha, _eval_hash, _ref, *, shadow):
        attempted.append(number)
        if number == 2:
            raise RuntimeError("dispatch boom")

    with caplog.at_level(logging.ERROR, logger="greenlight"), pytest.raises(RuntimeError) as excinfo:
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token, **_kwargs: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=boom_fingerprint,
            read_state=lambda _repo, _numbers: {},
            read_reverted=_no_reverted,
            dispatch=boom_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # PR1 fails fingerprinting and PR2 fails dispatch: a single end-of-scan RuntimeError surfaces
    # both failure classes distinctly, and healthy PR3 still dispatches.
    message = str(excinfo.value)
    assert "1 PR(s) failed during scan: [1]" in message
    assert "failed to dispatch 1 PR(s): [2]" in message
    assert attempted == [2, 3]


def test_scan_larger_than_worker_pool_fingerprints_every_pr(make_config):
    numbers = list(range(1, review._FINGERPRINT_WORKERS + 5))
    scan = _run_scan(
        make_config,
        listed=[_open_pr(n) for n in numbers],
        fingerprints={n: (f"headsha{n}", _HASH_A) for n in numbers},
    )

    # More tasks than workers must all run with none dropped; worker threads append in
    # nondeterministic order, so the fingerprinted set is compared rather than its order.
    assert sorted(scan.fingerprinted) == numbers
    assert [number for number, *_ in scan.dispatched] == numbers


def test_fingerprints_run_concurrently_across_workers(make_config):
    # Fill the pool to prove full concurrency, but demand >=2 parties even if the pool is
    # shrunk to 1: a 1-party barrier is satisfied by a single serial task and proves nothing.
    k = max(2, review._FINGERPRINT_WORKERS)
    numbers = list(range(1, k + 1))
    barrier = threading.Barrier(k, timeout=5)
    dispatched: list[int] = []

    def barrier_fingerprint(_client, number, _authorized, _skip):
        barrier.wait()
        return (f"headsha{number}", _HASH_A)

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref, *, shadow):
        dispatched.append(number)

    review.run(
        make_config(github_token="t"),
        build_github=lambda _token, **_kwargs: _CLIENT,
        fetch=lambda _client: [_open_pr(n) for n in numbers],
        fingerprint=barrier_fingerprint,
        read_state=lambda _repo, _numbers: {},
        read_reverted=_no_reverted,
        dispatch=fake_dispatch,
        resolve_authorized=lambda: _AUTHORIZED,
        now=lambda: _NOW,
    )

    # Every task blocks on the k-party barrier before returning, so only genuine concurrency
    # (k workers running at once) lets all parties arrive and release. Serial execution would
    # leave the barrier short, time out into BrokenBarrierError, and raise RuntimeError here.
    assert sorted(dispatched) == numbers


def test_worker_clients_are_isolated_and_exclude_main_client(make_config):
    # Force >=2 tasks in flight at once (see the concurrency test): isolation is only
    # meaningful when multiple borrowed clients are held simultaneously.
    k = max(2, review._FINGERPRINT_WORKERS)
    numbers = list(range(1, k + 1))
    barrier = threading.Barrier(k, timeout=5)
    built: list[object] = []

    def factory(_token, **_kwargs):
        client = object()
        built.append(client)
        return cast("Github", client)

    seen: dict[int, object] = {}

    def recording_fingerprint(client, number, _authorized, _skip):
        seen[number] = client
        barrier.wait()
        return (f"headsha{number}", _HASH_A)

    dispatched: list[int] = []

    def fake_dispatch(_client, number, head_sha, eval_hash, dispatch_ref, *, shadow):
        dispatched.append(number)

    review.run(
        make_config(github_token="t"),
        build_github=factory,
        fetch=lambda _client: [_open_pr(n) for n in numbers],
        fingerprint=recording_fingerprint,
        read_state=lambda _repo, _numbers: {},
        read_reverted=_no_reverted,
        dispatch=fake_dispatch,
        resolve_authorized=lambda: _AUTHORIZED,
        now=lambda: _NOW,
    )

    main_client = built[0]
    worker_clients = set(built[1:])
    passed = set(seen.values())
    # The barrier holds all k tasks in-flight at once, so each must be holding a different
    # borrowed client -- proving per-task isolation. The main client drives fetch/dispatch
    # only and must never reach a worker, or the shared-client data race would be back.
    assert passed <= worker_clients
    assert main_client not in passed
    assert len(passed) > 1
    assert sorted(dispatched) == numbers


def test_run_closes_main_and_worker_clients(make_config):
    class _Closeable:
        def __init__(self, seconds_between_requests: float | None) -> None:
            self.closed = 0
            self.seconds_between_requests = seconds_between_requests

        def close(self) -> None:
            self.closed += 1

    built: list[_Closeable] = []

    def factory(_token, *, seconds_between_requests=None):
        client = _Closeable(seconds_between_requests)
        built.append(client)
        return cast("Github", client)

    review.run(
        make_config(github_token="t"),
        build_github=factory,
        fetch=lambda _client: [_open_pr(1), _open_pr(2)],
        fingerprint=lambda _client, number, _authorized, _skip: (f"headsha{number}", _HASH_A),
        read_state=lambda _repo, _numbers: {},
        read_reverted=_no_reverted,
        dispatch=lambda *_args, **_kwargs: None,
        resolve_authorized=lambda: _AUTHORIZED,
        now=lambda: _NOW,
    )

    # main client + min(_FINGERPRINT_WORKERS, 2 PRs) = 2 worker clients are all built, and
    # each is closed exactly once as the scan unwinds -- the connection pools are not leaked.
    assert len(built) == 3
    assert all(client.closed == 1 for client in built)
    # The main client (built first) keeps PyGithub's default pacing -- no kwarg passed -- while the
    # two fingerprint worker clients are throttled to bound the fan-out's aggregate request rate.
    assert built[0].seconds_between_requests is None
    assert [c.seconds_between_requests for c in built[1:]] == [review._FINGERPRINT_SECONDS_BETWEEN_REQUESTS] * 2


def test_fingerprint_throttle_stays_under_burst_limit():
    # The asserted quantity is the fan-out's aggregate request rate (workers / seconds-between-requests).
    # 8 req/s is our own conservative budget, NOT a GitHub-published limit -- it is the ceiling we chose
    # to stay comfortably under GitHub's (undocumented, variable) secondary/burst rate limit. It bounds
    # only this fingerprint fan-out; the listing, dispatch, verdict, and authz clients each pace
    # themselves independently and sit outside this budget.
    assert review._FINGERPRINT_WORKERS / review._FINGERPRINT_SECONDS_BETWEEN_REQUESTS <= 8


def test_close_client_swallows_close_errors(caplog):
    class _Boom:
        def close(self) -> None:
            raise RuntimeError("close boom")

    with caplog.at_level(logging.ERROR, logger="greenlight"):
        review._close_client(cast("Github", _Boom()))

    # A failing close must never raise, so it cannot mask the scan's real outcome; it is
    # logged with exc_info instead.
    assert "failed to close GitHub client" in caplog.text
    assert any(record.exc_info is not None for record in caplog.records)


def test_fingerprint_task_returns_client_on_exception():
    pool: queue.Queue[Github] = queue.Queue()
    client = cast("Github", object())
    pool.put(client)
    cancel_event = threading.Event()

    def boom(_client, _number, _authorized, _skip):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        scan_runner._fingerprint_task(boom, pool, 1, _AUTHORIZED, True, cancel_event)

    # The borrowed client must return to the pool even when fingerprint raises; otherwise a scan
    # with more PRs than workers drains the pool and queue.get blocks the scan forever.
    assert pool.get_nowait() is client
    # A non-rate-limit failure must not trip the shared cancel event -- only rate limits abandon.
    assert not cancel_event.is_set()


def test_rate_limit_abandons_remaining_fingerprints(make_config, monkeypatch, caplog):
    from github import RateLimitExceededException

    # Pin one worker for a deterministic FIFO order: PR1 runs first and trips the cancel event before
    # PR2/PR3 start, so the "stop starting new tasks" behaviour is observable without racing workers.
    monkeypatch.setattr(review, "_FINGERPRINT_WORKERS", 1)
    fingerprinted: list[int] = []
    dispatched: list[int] = []

    def fingerprint(_client, number, _authorized, _skip):
        fingerprinted.append(number)
        if number == 1:
            raise RateLimitExceededException(403)
        return (f"headsha{number}", _HASH_A)

    def fake_dispatch(_client, number, _head_sha, _eval_hash, _ref, *, shadow):
        dispatched.append(number)

    with caplog.at_level(logging.WARNING, logger="greenlight"), pytest.raises(RuntimeError) as excinfo:
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token, **_kwargs: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=fingerprint,
            read_state=lambda _repo, _numbers: {},
            read_reverted=_no_reverted,
            dispatch=fake_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # PR1's rate limit sets the shared cancel event, so the queued PR2/PR3 short-circuit to _CANCELLED
    # without ever calling fingerprint (only PR1 appears). A cancelled task is not a failure: PR1 lands
    # in `failed`, PR2/PR3 are counted as abandoned (not failed), and nothing dispatches.
    assert fingerprinted == [1]
    assert dispatched == []
    # The abandonment is surfaced, never silently dropped: a warning names the count, and the
    # end-of-scan RuntimeError carries both the failed PR and the abandoned ones distinctly so the
    # scan still fails closed on an incomplete pass.
    message = str(excinfo.value)
    assert "1 PR(s) failed during scan: [1]" in message
    assert "2 PR(s) abandoned due to rate limit: [2, 3]" in message
    assert "abandoned 2 of 3" in caplog.text


def test_rate_limit_defers_completed_candidate_without_dispatching(make_config, monkeypatch, caplog):
    from github import RateLimitExceededException

    monkeypatch.setattr(review, "_FINGERPRINT_WORKERS", 1)
    fingerprinted: list[int] = []
    dispatched: list[int] = []

    def fingerprint(_client, number, _authorized, _skip):
        fingerprinted.append(number)
        if number == 2:
            raise RateLimitExceededException(403)
        return (f"headsha{number}", _HASH_A)

    def fake_dispatch(_client, number, _head_sha, _eval_hash, _ref, *, shadow):
        dispatched.append(number)

    with caplog.at_level(logging.WARNING, logger="greenlight"), pytest.raises(RuntimeError) as excinfo:
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token, **_kwargs: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=fingerprint,
            read_state=lambda _repo, _numbers: {},
            read_reverted=_no_reverted,
            dispatch=fake_dispatch,
            poke_drci=_boom_poke,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # PR1 completes as a candidate before PR2 hits the rate limit, but a dispatch is a workflow_dispatch
    # POST on the same throttled token -- exactly what secondary-rate-limit detection punishes -- so the
    # whole dispatch phase is skipped once the cancel event trips. PR1 is deferred, not lost: no state
    # row is written, so the next scan re-fingerprints and dispatches it once the limit clears. PR2 trips
    # the event, so PR3 short-circuits without being fingerprinted.
    assert fingerprinted == [1, 2]
    assert dispatched == []
    # The deferral is surfaced by the merged rate-limit warning, and the scan still fails closed: PR2
    # (failed) and PR3 (abandoned) are carried distinctly in the end-of-scan RuntimeError.
    assert "skipping dispatch of 1 completed candidate(s) this pass" in caplog.text
    assert "abandoned 1 of 3" in caplog.text
    message = str(excinfo.value)
    assert "1 PR(s) failed during scan: [2]" in message
    assert "1 PR(s) abandoned due to rate limit: [3]" in message


def test_rate_limit_on_last_task_skips_dispatch_with_no_abandoned(make_config, monkeypatch, caplog):
    from github import RateLimitExceededException

    # The gate keys off cancel_event, not the `abandoned` list, precisely for this case: the rate limit
    # hits the LAST task to run, so no queued task is left to short-circuit to _CANCELLED and `abandoned`
    # stays empty -- yet the event IS set, so dispatch must still be skipped. A regression to `if abandoned:`
    # would pass every other test but wrongly dispatch the completed candidates onto the throttled token here.
    monkeypatch.setattr(review, "_FINGERPRINT_WORKERS", 1)
    fingerprinted: list[int] = []
    dispatched: list[int] = []

    def fingerprint(_client, number, _authorized, _skip):
        fingerprinted.append(number)
        if number == 3:
            raise RateLimitExceededException(403)
        return (f"headsha{number}", _HASH_A)

    def fake_dispatch(_client, number, _head_sha, _eval_hash, _ref, *, shadow):
        dispatched.append(number)

    with caplog.at_level(logging.WARNING, logger="greenlight"), pytest.raises(RuntimeError) as excinfo:
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token, **_kwargs: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=fingerprint,
            read_state=lambda _repo, _numbers: {},
            read_reverted=_no_reverted,
            dispatch=fake_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # PR1 and PR2 complete as candidates; PR3 (the last task) trips the cancel event with nothing left to
    # cancel, so abandoned is empty. Dispatch is still skipped -- the two completed candidates are deferred.
    assert fingerprinted == [1, 2, 3]
    assert dispatched == []
    assert "skipping dispatch of 2 completed candidate(s) this pass" in caplog.text
    # abandoned is empty, so the fail-closed RuntimeError carries only the failed clause (the last PR) and
    # no "abandoned" clause -- the scan still signals incomplete via the rate-limited task landing in failed.
    message = str(excinfo.value)
    assert "1 PR(s) failed during scan: [3]" in message
    assert "abandoned" not in message


def test_rate_limit_abandonment_breaks_max_dispatch_batches(make_config, monkeypatch):
    from github import RateLimitExceededException

    monkeypatch.setattr(review, "_FINGERPRINT_WORKERS", 1)
    fingerprinted: list[int] = []
    dispatched: list[int] = []

    def fingerprint(_client, number, _authorized, _skip):
        fingerprinted.append(number)
        if number == 2:
            raise RateLimitExceededException(403)
        return (f"headsha{number}", _HASH_A)

    def fake_dispatch(_client, number, _head_sha, _eval_hash, _ref, *, shadow):
        dispatched.append(number)

    with pytest.raises(RuntimeError, match=r"1 PR\(s\) failed during scan: \[2\]"):
        review.run(
            make_config(github_token="t"),
            max_dispatches=5,
            build_github=lambda _token, **_kwargs: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=fingerprint,
            read_state=lambda _repo, _numbers: {},
            read_reverted=_no_reverted,
            dispatch=fake_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # The capped path (_fingerprint_until_dispatchable) fingerprints in worker-sized batches (size 1
    # here). PR1 completes, PR2 hits the rate limit and trips the cancel event, so the batch loop
    # breaks before submitting PR3 -- the cap of 5 is never the limiter, the cancellation is. The
    # tripped event then gates the dispatch phase, so PR1 is deferred rather than dispatched.
    assert fingerprinted == [1, 2]
    assert dispatched == []


def test_normal_scan_dispatches_when_not_rate_limited(make_config, monkeypatch, caplog):
    # Guard against over-gating: with no rate limit the cancel event never trips, so the dispatch phase
    # must run exactly as before -- every completed candidate is dispatched and no deferral warning fires.
    monkeypatch.setattr(review, "_FINGERPRINT_WORKERS", 1)
    fingerprinted: list[int] = []
    dispatched: list[int] = []

    def fingerprint(_client, number, _authorized, _skip):
        fingerprinted.append(number)
        return (f"headsha{number}", _HASH_A)

    def fake_dispatch(_client, number, _head_sha, _eval_hash, _ref, *, shadow):
        dispatched.append(number)

    with caplog.at_level(logging.WARNING, logger="greenlight"):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token, **_kwargs: _CLIENT,
            fetch=lambda _client: [_open_pr(1), _open_pr(2), _open_pr(3)],
            fingerprint=fingerprint,
            read_state=lambda _repo, _numbers: {},
            read_reverted=_no_reverted,
            dispatch=fake_dispatch,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    assert fingerprinted == [1, 2, 3]
    assert dispatched == [1, 2, 3]
    assert "skipping dispatch" not in caplog.text
    assert "rate limit" not in caplog.text


def test_fetch_failure_still_closes_main_client(make_config):
    client = Mock()

    def boom_fetch(_client):
        raise RuntimeError("fetch boom")

    with pytest.raises(RuntimeError, match="fetch boom"):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token, **_kwargs: cast("Github", client),
            fetch=boom_fetch,
            fingerprint=lambda _client, number, _authorized, _skip: (f"headsha{number}", _HASH_A),
            read_state=lambda _repo, _numbers: {},
            read_reverted=_no_reverted,
            dispatch=lambda *_args, **_kwargs: None,
            resolve_authorized=lambda: _AUTHORIZED,
            now=lambda: _NOW,
        )

    # fetch raises after the main client is built but before any worker exists; the ExitStack must
    # still close it as it unwinds, or every early failure leaks the client's connection pool.
    client.close.assert_called_once()


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
    with caplog.at_level(logging.DEBUG, logger="greenlight"):
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


def test_per_pr_listing_detail_is_below_info(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        _run_scan(
            make_config,
            listed=[_open_pr(1), _open_pr(2)],
            fingerprints={1: ("h1", _HASH_A), 2: ("h2", _HASH_A)},
        )

    # One info line per open PR is affordable for the trusted-author set and not for the whole
    # merge_rules approver cohort, which is an order of magnitude larger and rescanned every few
    # minutes. The aggregate count stays at info; the per-PR detail is debug-only.
    assert "found 2 open PR(s)" in caplog.text
    assert "open PR #" not in caplog.text


def test_run_without_token_raises(make_config):
    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        review.run(make_config(github_token=None), resolve_authorized=lambda: _AUTHORIZED)


def test_run_missing_token_does_not_resolve_authorized(make_config):
    resolved: list[int] = []

    def counting_resolve() -> frozenset[str]:
        resolved.append(1)
        return _AUTHORIZED

    with pytest.raises(ValueError, match="PYTORCH_GREENLIGHT_GITHUB_TOKEN"):
        review.run(make_config(github_token=None), resolve_authorized=counting_resolve)

    # The token check precedes authorization resolution, so a tokenless scan never builds an
    # authz client -- it fails fast on the cheaper local check.
    assert resolved == []


def test_run_cold_authorized_failure_propagates(make_config):
    def boom_resolve() -> frozenset[str]:
        raise RuntimeError("merge_rules unreachable")

    # A cold resolver failure must propagate out of run() (the daemon backs off, the one-shot exits
    # non-zero); run never falls back to hashing all human comments.
    with pytest.raises(RuntimeError, match="merge_rules unreachable"):
        review.run(
            make_config(github_token="t"),
            build_github=lambda _token, **_kwargs: _CLIENT,
            fetch=lambda _client: [_open_pr(1)],
            fingerprint=lambda _client, number, _authorized, _skip: (f"headsha{number}", _HASH_A),
            read_state=lambda _repo, _numbers: {},
            read_reverted=_no_reverted,
            dispatch=lambda *_args, **_kwargs: None,
            resolve_authorized=boom_resolve,
            now=lambda: _NOW,
        )


def test_run_resolves_authorized_once_and_threads_to_fingerprints(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1), _open_pr(2), _open_pr(3)],
        fingerprints={1: ("h1", _HASH_A), 2: ("h2", _HASH_A), 3: ("h3", _HASH_A)},
        authorized=frozenset({"alice", "bob"}),
    )

    # The resolver is called exactly once per scan (not once per PR), and that one resolved set is
    # threaded into every fingerprint call.
    assert scan.resolver_calls == 1
    assert scan.authorized_seen == [frozenset({"alice", "bob"})] * 3


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
    assert captured["repo"] == TARGET_REPO
    assert captured["authors"] == cohort.TRUSTED_AUTHORS


def test_default_fetch_author_forwards_to_get_pr_author(monkeypatch):
    captured: dict[str, object] = {}

    def fake_get_pr_author(client, repo, pr_number):
        captured["client"] = client
        captured["repo"] = repo
        captured["pr_number"] = pr_number
        return "albanD"

    monkeypatch.setattr(github_client, "get_pr_author", fake_get_pr_author)

    result = review._default_fetch_author(_CLIENT, 7)

    assert result == "albanD"
    assert captured["client"] is _CLIENT
    assert captured["repo"] == TARGET_REPO
    assert captured["pr_number"] == 7


def test_default_fingerprint_forwards_to_fingerprint_pr(monkeypatch):
    captured: dict[str, object] = {}

    def fake_fingerprint_pr(client, repo, pr_number, *, authorized_logins, allow_skip, skip_on_approval):
        captured["client"] = client
        captured["repo"] = repo
        captured["pr_number"] = pr_number
        captured["authorized_logins"] = authorized_logins
        captured["allow_skip"] = allow_skip
        captured["skip_on_approval"] = skip_on_approval
        return ("headsha", _HASH_A)

    monkeypatch.setattr(github_client, "fingerprint_pr", fake_fingerprint_pr)

    result = review._default_fingerprint(_CLIENT, 7, _AUTHORIZED, True)

    assert result == ("headsha", _HASH_A)
    assert captured["client"] is _CLIENT
    assert captured["repo"] == TARGET_REPO
    assert captured["pr_number"] == 7
    assert captured["authorized_logins"] is _AUTHORIZED
    # allow_skip is always True; skip_on_approval is forwarded verbatim from the caller.
    assert captured["allow_skip"] is True
    assert captured["skip_on_approval"] is True


def test_utcnow_is_naive_utc():
    now = review._utcnow()

    assert now.tzinfo is None


def test_scan_changes_requested_is_dropped_no_dispatch(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        scan = _run_scan(
            make_config,
            listed=[_open_pr(1)],
            fingerprints={1: ReviewSkip(CHANGES_REQUESTED, "changes requested by bob")},
        )

    # A human-decided PR short-circuits on the listing scan: dropped, never dispatched, and no
    # refusal comment (the listing path drops silently). It is not a failure, so run() does not raise.
    assert scan.dispatched == []
    assert scan.refusals == []
    assert scan.skip_on_approval_seen == [True]
    assert "PR #1: SKIP (changes_requested): changes requested by bob" in caplog.text


def test_scan_human_approved_is_dropped_no_dispatch(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1)],
        fingerprints={1: ReviewSkip(HUMAN_APPROVED, "approved by alice")},
    )

    # On the listing scan an authorized-human approval also short-circuits: dropped, no dispatch.
    assert scan.dispatched == []
    assert scan.refusals == []


def test_scan_skip_alongside_healthy_pr_does_not_raise(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1), _open_pr(2)],
        fingerprints={1: ReviewSkip(HUMAN_APPROVED, "approved by alice"), 2: ("headsha2", _HASH_A)},
    )

    # Regression: a ReviewSkip must never be counted as a failure. PR1 is dropped and PR2 still
    # dispatches; run() returning normally (a _Scan, not a raise) proves the skip was not in `failed`.
    assert [number for number, *_ in scan.dispatched] == [2]
    assert scan.refusals == []


def test_scan_skip_on_approval_is_true_on_listing_path(make_config):
    scan = _run_scan(make_config, listed=[_open_pr(1)], fingerprints={1: ("headsha1", _HASH_A)})

    # The listing scan passes skip_on_approval=True so an approval can short-circuit it.
    assert scan.skip_on_approval_seen == [True]


def test_pr_changes_requested_refuses_with_comment(make_config, caplog):
    with caplog.at_level(logging.INFO, logger="greenlight"):
        scan = _run_scan(
            make_config,
            pr=5,
            fingerprints={5: ReviewSkip(CHANGES_REQUESTED, "changes requested by bob")},
            bot_login="greenlight-app[bot]",
        )

    # On the --pr recheck a changes-requested review is refused, not dispatched: no dispatch, and a
    # single refusal comment authored as the bot, carrying the distinct refusal marker and the detail.
    assert scan.dispatched == []
    assert scan.skip_on_approval_seen == [False]
    assert len(scan.refusals) == 1
    pr_number, marker, body, author_login = scan.refusals[0]
    assert pr_number == 5
    assert marker == RECHECK_REFUSAL_MARKER
    assert author_login == "greenlight-app[bot]"
    assert body.startswith(RECHECK_REFUSAL_MARKER)
    assert "changes requested by bob" in body
    assert "posted recheck refusal for PR #5" in caplog.text


def test_pr_approval_is_not_skipped_and_dispatches(make_config):
    scan = _run_scan(
        make_config,
        pr=5,
        fingerprints={5: ("headsha5", _HASH_A)},
        bot_login="greenlight-app[bot]",
    )

    # The --pr recheck passes skip_on_approval=False, so an approval never short-circuits it: the PR
    # is fingerprinted to a real (head_sha, eval_hash) and dispatched, and no refusal is posted.
    assert scan.skip_on_approval_seen == [False]
    assert scan.dispatched == [(5, "headsha5", _HASH_A, DEFAULT_DISPATCH_REF)]
    assert scan.refusals == []


def test_pr_changes_requested_without_bot_login_logs_and_skips_posting(make_config, caplog):
    with caplog.at_level(logging.ERROR, logger="greenlight"):
        scan = _run_scan(
            make_config,
            pr=5,
            fingerprints={5: ReviewSkip(CHANGES_REQUESTED, "changes requested by bob")},
            bot_login="",
        )

    # A refusal needs the bot login to author-scope the comment; with none set the post is skipped
    # with an error rather than crashing the scan, and nothing is dispatched.
    assert scan.dispatched == []
    assert scan.refusals == []
    assert "BOT_LOGIN is required to post" in caplog.text


# An untrusted login: outside both authz gates, and therefore evaluated in shadow.
_COHORT_ONLY_AUTHOR = "alice"

_TRUSTED_VS_SHADOW = [
    pytest.param("albanD", False, id="trusted-author"),
    pytest.param(_COHORT_ONLY_AUTHOR, True, id="cohort-author-outside-the-trusted-set"),
]


@pytest.mark.parametrize(("author", "shadow"), _TRUSTED_VS_SHADOW)
def test_dispatch_marker_carries_the_authors_shadow_and_gates_the_poke(make_config, author, shadow):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, author=author)],
        fingerprints={1: ("headsha1", _HASH_A)},
    )

    # The listing already knows the author, so the scan decides once and spends it three ways: the
    # workflow input that withholds the approval, the row the merge gate reads, and whether Dr. CI
    # is worth poking at all -- a shadow row is filtered out of the query a rebuild would run.
    assert scan.dispatch_shadow == [(1, shadow)]
    assert scan.emit_shadow == [(1, shadow)]
    assert [number for _repo, number, _config in scan.poked] == ([] if shadow else [1])


@pytest.mark.parametrize(("author", "shadow"), _TRUSTED_VS_SHADOW)
def test_reverted_row_carries_the_authors_shadow_and_gates_the_poke(make_config, author, shadow):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, updated_at=_NEW, labels=("Reverted",), author=author)],
        fingerprints={},
        bot_login="greenlight-app[bot]",
        dismissed_ids={1: [901]},
    )

    # revert_guard writes the scan's other state row, and it has no author of its own -- the same
    # listing answer is threaded in rather than costing a second GitHub read per reverted PR.
    assert scan.reverted_shadow == [(1, shadow)]
    assert scan.reverted_emitted == [(TARGET_REPO, 1, "headsha1", 1)]
    assert scan.dismissals == [(1, "greenlight-app[bot]", revert_guard._DISMISS_MESSAGE)]
    assert [number for _repo, number, _config in scan.poked] == ([] if shadow else [1])


def test_mixed_cohort_batch_stamps_each_pr_independently(make_config):
    scan = _run_scan(
        make_config,
        listed=[_open_pr(1, author="albanD"), _open_pr(2, author=_COHORT_ONLY_AUTHOR)],
        fingerprints={1: ("headsha1", _HASH_A), 2: ("headsha2", _HASH_A)},
    )

    # Every steady-state scan carries both cohorts at once, so a single per-scan answer would be
    # wrong for half the batch in either direction.
    assert scan.dispatch_shadow == [(1, False), (2, True)]
    assert scan.emit_shadow == [(1, False), (2, True)]
    assert [number for _repo, number, _config in scan.poked] == [1]


def test_pr_recheck_is_never_shadow_because_its_author_gate_already_ran(make_config):
    scan = _run_scan(make_config, pr=5, fingerprints={5: ("headsha5", _HASH_A)}, author="albanD")

    # The --pr path has no listing to read an author from, so it reuses the one the target-author
    # gate already fetched -- which that gate has already required to be trusted.
    assert scan.author_fetched == [5]
    assert scan.dispatch_shadow == [(5, False)]
    assert scan.emit_shadow == [(5, False)]


def test_allow_untrusted_author_still_resolves_the_author_so_a_trusted_pr_stays_authoritative(make_config):
    scan = _run_scan(
        make_config,
        pr=5,
        fingerprints={5: ("headsha5", _HASH_A)},
        author="albanD",
        allow_untrusted_author=True,
    )

    # Regression guard for a live-approval revocation. The flag once skipped the only lookup that
    # names the author, leaving it None -- and cohort.is_shadow(None) is True, so the run recorded a
    # shadow verdict, whose LAND dismisses greenlight's existing approval. Pointed at a TRUSTED
    # author's PR, a local convenience flag therefore revoked a production approval. The lookup is
    # unconditional now, so the flag cannot change what cohort a PR is in -- only whether an
    # untrusted one is turned away.
    assert scan.author_fetched == [5]
    assert scan.dispatch_shadow == [(5, False)]
    assert scan.emit_shadow == [(5, False)]


def test_allow_untrusted_author_keeps_an_untrusted_pr_shadow(make_config):
    scan = _run_scan(
        make_config,
        pr=5,
        fingerprints={5: ("headsha5", _HASH_A)},
        author="mallory",
        allow_untrusted_author=True,
    )

    # The other half of that same lookup: waiving the refusal must not waive shadow. The override
    # stays a way to exercise the reviewer, never a way to have an arbitrary PR approved -- and the
    # Dr. CI query drops shadow rows, so there is nothing to poke for.
    assert scan.author_fetched == [5]
    assert scan.dispatch_shadow == [(5, True)]
    assert scan.emit_shadow == [(5, True)]
    assert scan.poked == []


def test_allow_untrusted_author_with_an_unnameable_author_fails_closed_to_shadow(make_config):
    scan = _run_scan(
        make_config,
        pr=5,
        fingerprints={5: ("headsha5", _HASH_A)},
        author=None,
        allow_untrusted_author=True,
    )

    # An author GitHub cannot name is not trusted, so the flag is what lets this review run at all --
    # and it still resolves to shadow. Unknown is the one input where the fail-closed answer and the
    # old skip-the-lookup bug agreed, so pin it explicitly rather than leave it to that coincidence.
    assert scan.author_fetched == [5]
    assert scan.dispatch_shadow == [(5, True)]
    assert scan.emit_shadow == [(5, True)]
    assert scan.dispatched == [(5, "headsha5", _HASH_A, DEFAULT_DISPATCH_REF)]
